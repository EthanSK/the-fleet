// Registry and schema validation: manifests, machines, aliases, registration.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { FleetError } from '../src/errors.ts';
import { loadProject, registerProject, selectMachine } from '../src/registry.ts';
import { findMachine, parseMachines } from '../src/schema/machines.ts';
import { parseManifest } from '../src/schema/manifest.ts';
import { temporaryDirectory, writeFiles } from './helpers/fixtures.ts';
import { resolveStatePaths } from '../src/paths.ts';

function manifestWith(profile: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    id: 'demo',
    sync: { include: ['src/**'] },
    profiles: { unit: { description: 'Unit tests', kind: 'build', argv: ['make'], timeoutMinutes: 5, ...profile } },
    ...extra,
  };
}

function rejects(value: unknown, pattern: RegExp): void {
  assert.throws(() => parseManifest(value, 'demo.json'), (error: unknown) => error instanceof FleetError && pattern.test(error.message));
}

test('a complete manifest parses with defaults filled in', () => {
  const manifest = parseManifest(manifestWith({ kind: 'test', success: { minTestCount: { pattern: 'Executed (\\d+) tests', min: 1 } } }), 'demo.json');
  const profile = manifest.profiles['unit'];
  assert.ok(profile);
  assert.equal(profile.cwd, '.');
  assert.equal(profile.maxArtifactMiB, 512);
  assert.equal(manifest.sync.maxTotalMiB, 512);
  assert.deepEqual(manifest.localOnly, []);
});

test('a test profile without success criteria is rejected so zero tests cannot pass', () => {
  rejects(manifestWith({ kind: 'test' }), /zero tests can never pass/);
});

test('a blocked test profile may omit success criteria', () => {
  const manifest = parseManifest(manifestWith({ kind: 'test', blocked: 'needs the Xcode workflow' }), 'demo.json');
  assert.equal(manifest.profiles['unit']?.blocked, 'needs the Xcode workflow');
});

test('minTestCount needs a capture group', () => {
  rejects(manifestWith({ kind: 'test', success: { minTestCount: { pattern: 'Executed \\d+ tests', min: 1 } } }), /capture group/);
});

test('unknown fields are refused with their path', () => {
  rejects(manifestWith({ timeout: 5 }), /profiles\.unit\.timeout: unknown field/);
});

test('agent CLIs are refused as profile commands', () => {
  rejects(manifestWith({ argv: ['/opt/homebrew/bin/codex', 'exec'] }), /starts an agent session/);
  rejects(manifestWith({ prepare: [['claude', '-p', 'x']] }), /starts an agent session/);
});

test('cwd and artifact paths cannot escape the job folder', () => {
  rejects(manifestWith({ cwd: '../elsewhere' }), /cwd/);
  rejects(manifestWith({ artifacts: ['/etc/passwd'] }), /relative/);
  rejects(manifestWith({ artifacts: ['build/../../x'] }), /"\.\."/);
  rejects(manifestWith({ artifacts: ['--delete'] }), /must not start with "-"/);
});

test('PATH and runner variables cannot be overridden by profile env', () => {
  rejects(manifestWith({ env: { PATH: '/tmp' } }), /pathPrepend/);
  rejects(manifestWith({ env: { FLEET_RUNNER_JOB_DIR: '/tmp' } }), /set by the runner/);
});

test('sync patterns are validated', () => {
  rejects(manifestWith({ extraInputs: ['../outside/**'] }), /extraInputs\[0\]/);
  rejects({ ...(manifestWith({}) as object), sync: { include: ['../x/**'] } }, /sync\.include\[0\]/);
  rejects({ ...(manifestWith({}) as object), sync: { include: ['src/[ab].c'] } }, /character classes/);
  rejects({ ...(manifestWith({}) as object), sync: { include: [] } }, /must not be empty/);
});

test('finalizers require bounded finite time and refuse agent sessions', () => {
  rejects(manifestWith({ finalizer: { argv: ['echo', 'cleanup'], timeoutSeconds: 0 } }), /timeoutSeconds/);
  rejects(manifestWith({ finalizer: { argv: ['echo', 'cleanup'], timeoutSeconds: 61 } }), /timeoutSeconds/);
  rejects(manifestWith({ finalizer: { argv: ['codex'], timeoutSeconds: 10 } }), /agent session/);
});

test('every profile needs an explicit timeout', () => {
  const value = manifestWith({}) as { profiles: { unit: Record<string, unknown> } };
  delete value.profiles.unit['timeoutMinutes'];
  rejects(value, /timeoutMinutes: must be a number/);
});

const machinesJson = {
  schemaVersion: 1,
  defaultMachine: 'mini',
  machines: [{ id: 'mini', transport: { kind: 'agent-bridge', target: 'Mac-Mini' }, aliases: ['Ethans-Mac-mini'], remoteRoot: '~/FleetRunner.noindex' }],
};

test('aliases resolve to the same machine entry, so they share its lock', () => {
  const registry = parseMachines(machinesJson, 'machines.json');
  const byTarget = findMachine(registry, 'mac-mini');
  const byAlias = findMachine(registry, 'ETHANS-MAC-MINI');
  assert.ok(byTarget && byAlias);
  assert.equal(byTarget, byAlias);
  assert.equal(selectMachine(registry, 'Ethans-Mac-mini', undefined).remoteRoot, '~/FleetRunner.noindex');
});

test('one name in two machine entries is refused', () => {
  const duplicate = {
    ...machinesJson,
    machines: [
      ...machinesJson.machines,
      { id: 'mini-two', transport: { kind: 'agent-bridge', target: 'Ethans-Mac-mini' }, remoteRoot: '~/Other.noindex' },
    ],
  };
  assert.throws(() => parseMachines(duplicate, 'machines.json'), /One physical machine needs one entry/);
});

test('the remote root must be a dedicated .noindex folder', () => {
  const withRoot = (remoteRoot: string): unknown => ({ ...machinesJson, machines: [{ ...machinesJson.machines[0], remoteRoot }] });
  assert.throws(() => parseMachines(withRoot('~/Projects'), 'm.json'), /\.noindex/);
  assert.throws(() => parseMachines(withRoot('~/../x.noindex'), 'm.json'), /"\.\."/);
  assert.throws(() => parseMachines(withRoot('relative.noindex'), 'm.json'), /absolute/);
  assert.doesNotThrow(() => parseMachines(withRoot('/Users/Shared/Fleet Runner.noindex'), 'm.json'));
});

test('there is no implicit local machine', () => {
  assert.throws(() => selectMachine({ schemaVersion: 1, machines: [] }, undefined, undefined), /No fleet machines registered/);
});

test('register stores a pointer and re-reads the manifest live', () => {
  const directory = temporaryDirectory();
  try {
    const paths = resolveStatePaths({ FLEET_RUNNER_HOME: join(directory.path, 'state') });
    const source = join(directory.path, 'my project');
    writeFiles(source, { 'src/a.txt': 'a' });
    const manifestPath = join(directory.path, 'demo.json');
    writeFiles(directory.path, { 'demo.json': JSON.stringify(manifestWith({})) });
    const entry = registerProject(paths, manifestPath, source, false);
    assert.equal(entry.sourceRoot, source);
    assert.throws(() => registerProject(paths, manifestPath, source, false), /already registered/);

    writeFiles(directory.path, { 'demo.json': JSON.stringify(manifestWith({ description: 'Changed' })) });
    assert.equal(loadProject(paths, 'demo').manifest.profiles['unit']?.description, 'Changed');
  } finally {
    directory.cleanup();
  }
});

test('a separate existing run store preserves canonical configuration and refuses missing scratch', () => {
  const directory = temporaryDirectory();
  try {
    const home = join(directory.path, 'configuration');
    const runs = join(directory.path, 'external-runs.noindex');
    writeFiles(runs, { 'kept.txt': 'existing volume' });
    const ordinary = resolveStatePaths({ FLEET_RUNNER_HOME: home });
    const external = resolveStatePaths({ FLEET_RUNNER_HOME: home, FLEET_RUNNER_RUNS_DIRECTORY: runs });
    assert.equal(external.runsDir, runs);
    assert.equal(external.machinesFile, ordinary.machinesFile);
    assert.equal(external.projectsDir, ordinary.projectsDir);
    assert.throws(() => resolveStatePaths({ FLEET_RUNNER_RUNS_DIRECTORY: join(directory.path, 'missing.noindex') }), /existing absolute/);
    assert.throws(() => resolveStatePaths({ FLEET_RUNNER_RUNS_DIRECTORY: 'relative.noindex' }), /existing absolute/);
  } finally { directory.cleanup(); }
});
