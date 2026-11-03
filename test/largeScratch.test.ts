// Private scratch configuration and the real archive lifecycle. Physical volume
// qualification is separate; these fixtures never write to a user's drive.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { loadMachines, loadProject, registerProject, serializeMachines } from '../src/registry.ts';
import { parseMachines, type LargeScratch } from '../src/schema/machines.ts';
import { runProfile } from '../src/run/runJob.ts';
import { inlineProject } from '../src/service/server.ts';
import { CapturedStream, testEnvironment, testMachine, writeFiles } from './helpers/fixtures.ts';
import { report, startServiceFixture } from './helpers/serviceFixture.ts';
import { LocalShellTransport } from './helpers/localShellTransport.ts';
import { runControl } from '../src/run/remoteChecks.ts';
import type { DiskSpaceProblem } from '../src/run/diskSpace.ts';

const execute = promisify(execFile);
const scratch: LargeScratch = { mountPoint: '/Volumes/Example', volumeUuid: '00000000-0000-4000-8000-000000000001', directory: 'AgentScratch.noindex/the-fleet', minFileMiB: 1, minFreeGiB: 0 };

test('private scratch validates and round-trips without changing the remote root or environment', () => {
  const registry = parseMachines({ schemaVersion: 1, machines: [testMachine({ largeScratch: scratch })] }, 'fixture');
  const saved = serializeMachines(registry);
  assert.deepEqual(parseMachines(saved, 'saved').machines[0]?.largeScratch, scratch);
  assert.equal(registry.machines[0]?.remoteRoot, '~/Fleet Runner.noindex');
  assert.deepEqual(registry.machines[0]?.env, {});
  for (const change of [{ mountPoint: '/' }, { mountPoint: '/Volumes/x/../y' }, { directory: '../other.noindex' }, { directory: '/outside.noindex' }, { directory: 'hot-source' }, { volumeUuid: '../device' }, { minFileMiB: 0 }, { minFreeGiB: -1 }, { typo: true }]) {
    assert.throws(() => parseMachines({ schemaVersion: 1, machines: [testMachine({ largeScratch: { ...scratch, ...change } })] }, 'fixture'));
  }
});

test('revision-checked settings retain scratch through unrelated edits and refuse changes during ownership', async () => {
  const f = await startServiceFixture();
  const revision = async () => String((await f.call('GET', '/v1/config')).body['revision']);
  try {
    const added = await f.call('POST', '/v1/machines', { revision: await revision(), id: 'mini', target: 'Mac-Mini', largeScratch: scratch });
    assert.equal(added.status, 200, added.text);
    assert.deepEqual(loadMachines(f.paths).machines[0]?.largeScratch, scratch);
    const unrelated = await f.call('PUT', '/v1/machines/mini', { revision: await revision(), description: 'Changed elsewhere' });
    assert.equal(unrelated.status, 200, unrelated.text);
    assert.deepEqual(loadMachines(f.paths).machines[0]?.largeScratch, scratch);
    f.reports.set('Mac-Mini', report('fp-mini'));
    const lease = await f.call('POST', '/v1/reservations', { owner: 'fixture', label: 'scratch fixture', machines: ['mini'] });
    assert.equal(lease.status, 200, lease.text);
    const reservation = lease.body['reservation'];
    assert.ok(reservation && typeof reservation === 'object' && 'id' in reservation);
    const busy = await f.call('PUT', '/v1/machines/mini', { revision: await revision(), largeScratch: null });
    assert.equal(busy.status, 409, busy.text);
    assert.deepEqual(loadMachines(f.paths).machines[0]?.largeScratch, scratch);
    const released = await f.call('POST', '/v1/release', { id: reservation.id, token: lease.body['token'] });
    assert.equal(released.status, 200, released.text);
    const cleared = await f.call('PUT', '/v1/machines/mini', { revision: await revision(), largeScratch: null });
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(loadMachines(f.paths).machines[0]?.largeScratch, undefined);
  } finally { await f.close(); }
});

test('a stale scratch destination cannot start a run after settings change', async () => {
  const f = await startServiceFixture({ execute: async () => { throw new Error('must not execute'); } });
  try {
    await f.call('POST', '/v1/machines', { revision: String((await f.call('GET', '/v1/config')).body['revision']), id: 'mini', target: 'Mac-Mini' });
    f.reports.set('Mac-Mini', report('fp-mini'));
    const machine = loadMachines(f.paths).machines[0]; assert.ok(machine);
    const project = inlineProject({ source: '.', files: ['a'], command: ['true'], timeoutMinutes: 1, kind: 'check' }, '/tmp');
    const stale = { ...machine, largeScratch: scratch };
    await assert.rejects(f.coordinator.runOne('fixture', 'b'.repeat(24), { ...project, paths: f.paths, machine: stale, transport: new LocalShellTransport('/tmp'), extraArgs: [], ignoreHeavyProcesses: false,
      io: { stdout: new CapturedStream(), stderr: new CapturedStream(), status: () => {} } }), /settings changed/);
    assert.equal(f.executed.length, 0);
  } finally { await f.close(); }
});

function archiveFixture(bytes: number, readOnlyMeta = false, spaceFault = false) {
  const f = testEnvironment();
  const source = join(f.root, 'source');
  // Replace only this test job's uploaded helper with a wrapper that forces
  // its existing volume-space decision. No real disk is filled or unmounted.
  const wrapper = `import runpy\nfrom pathlib import Path\nm=runpy.run_path(str(Path(__file__).with_suffix('.source.py')))\ndef full(*args, **kwargs):\n raise m['InsufficientScratchSpace']('The large scratch volume has insufficient free space.')\nm['capture'].__globals__['volume_fd']=full\nm['main']()\n`;
  const injection = spaceFault ? `p=Path(os.environ['FLEET_RUNNER_JOB_DIR'])/'meta/large_scratch.py'\np.rename(p.with_suffix('.source.py'))\np.write_text(${JSON.stringify(wrapper)})\n` : '';
  writeFiles(source, { 'run.py': `import os\nfrom pathlib import Path\n${readOnlyMeta ? "os.chmod(Path(os.environ['FLEET_RUNNER_JOB_DIR']) / 'meta', 0o555)\n" : ''}${injection}Path('payload.bin').write_bytes(b'a' * ${bytes})\nprint('tests 1')\n` });
  const manifest = join(f.root, 'project.json');
  writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, id: 'archive-fixture', sourceRoot: source, sync: { include: ['run.py'] }, profiles: { test: { description: 'Archive fixture', kind: 'test', argv: ['python3', 'run.py'], timeoutMinutes: 1, artifacts: ['payload.bin'], maxArtifactMiB: 4, success: { minTestCount: { pattern: 'tests ([0-9]+)', min: 1 } } } } }));
  registerProject(f.paths, manifest, undefined, false);
  // A missing fixture mount is deliberate: neither case may create it.
  const mountPoint = join(f.root, 'missing-volume');
  return { f, mountPoint, request: { paths: f.paths, project: loadProject(f.paths, 'archive-fixture'), profileName: 'test', machine: testMachine({ largeScratch: { ...scratch, mountPoint } }), transport: f.transport,
    sourceRoot: source, extraArgs: [], ignoreHeavyProcesses: false, io: { stdout: f.stdout, stderr: f.stderr, status: () => {} } } };
}

test('small output archives stay internal and succeed even when the configured drive is absent', { timeout: 30000 }, async () => {
  const { f, mountPoint, request } = archiveFixture(128);
  const events: DiskSpaceProblem[] = [];
  try {
    const result = await runProfile({ ...request, io: { ...request.io, onDiskSpaceProblem: event => { events.push(event); } } });
    assert.equal(result.receipt.outcome, 'passed', JSON.stringify(result.receipt));
    assert.equal(result.receipt.remote.lockReleased, true);
    assert.equal(existsSync(mountPoint), false);
    assert.equal(readFileSync(join(result.receiptPath, '..', 'artifacts/payload.bin')).length, 128);
    assert.equal(events.length, 0);
  } finally { f.cleanup(); }
});

test('a large archive refuses a missing mount without fallback, preserving output and ownership', { timeout: 30000 }, async () => {
  const { f, mountPoint, request } = archiveFixture(2 * 1024 * 1024);
  const events: DiskSpaceProblem[] = [];
  try {
    const result = await runProfile({ ...request, io: { ...request.io, onDiskSpaceProblem: event => { events.push(event); } } });
    assert.notEqual(result.receipt.outcome, 'passed');
    assert.equal(result.receipt.remote.lockReleased, false);
    assert.equal(result.receipt.remote.processesRemaining, false);
    assert.equal(existsSync(mountPoint), false);
    const job = join(f.remoteRoot, 'jobs', result.receipt.jobId);
    assert.equal(existsSync(join(job, 'src/payload.bin')), true);
    assert.equal(existsSync(join(job, 'meta/large-scratch-failed')), true);
    assert.equal(existsSync(join(job, 'artifacts.tar')), false);
    assert.equal(events.length, 0, 'an absent volume is not an insufficient-space decision');
  } finally { f.cleanup(); }
});

test('a verified archive-space refusal reports its cause and keeps normal retention in stream and control paths', { timeout: 30000 }, async () => {
  const { f, request } = archiveFixture(2 * 1024 * 1024, false, true);
  const events: DiskSpaceProblem[] = [];
  try {
    const result = await runProfile({ ...request, io: { ...request.io, onDiskSpaceProblem: event => { events.push(event); } } });
    assert.notEqual(result.receipt.outcome, 'passed');
    assert.equal(result.receipt.remote.lockReleased, false);
    assert.equal(result.receipt.remote.processesRemaining, false);
    assert.deepEqual(events, [{ machineId: request.machine.id, phase: 'archive', message: 'The large scratch volume has insufficient free space.' }]);
    const job = join(f.remoteRoot, 'jobs', result.receipt.jobId);
    assert.equal(existsSync(join(job, 'src/payload.bin')), true);
    const cleared = await runControl(f.transport, request.machine, 'clear-stale', result.receipt.jobId);
    assert.equal(cleared.result, 'artifact-capture-failed');
    assert.deepEqual(cleared.diskSpaceProblem, events[0]);
    assert.equal(existsSync(join(job, 'src/payload.bin')), true);
  } finally { f.cleanup(); }
});

test('the archive helper verifies identity, capacity, ownership, retention and bounded real tar writes', async () => {
  const fixture = fileURLToPath(new URL('largeScratchHelper.py', import.meta.url));
  const helper = fileURLToPath(new URL('../remote/large_scratch.py', import.meta.url));
  const result = await execute('python3', ['-B', fixture, helper], { timeout: 30000 });
  assert.match(result.stderr, /Ran \d+ tests/);
  assert.match(result.stderr, /\nOK\b/);
});

test('external capture retains source even when internal metadata cannot store its failure marker', { timeout: 30000 }, async () => {
  const { f, mountPoint, request } = archiveFixture(2 * 1024 * 1024, true);
  const job = join(f.remoteRoot, 'jobs', 'scratch-marker-failure');
  try {
    const result = await runProfile({ ...request, jobId: 'scratch-marker-failure' });
    assert.notEqual(result.receipt.outcome, 'passed');
    assert.equal(result.receipt.remote.lockReleased, false);
    assert.equal(result.receipt.remote.processesRemaining, false);
    assert.equal(existsSync(mountPoint), false);
    assert.equal(existsSync(join(job, 'src/payload.bin')), true);
    assert.equal(existsSync(join(job, 'meta/large-scratch-failed')), false);
  } finally {
    if (existsSync(join(job, 'meta'))) chmodSync(join(job, 'meta'), 0o700);
    f.cleanup();
  }
});
