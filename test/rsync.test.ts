// Real rsync protocol and supervisor tests: retained source remains separate
// from execution and command/env data, with exact files and bounded ownership.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadProject, registerProject } from '../src/registry.ts';
import { parseManifest } from '../src/schema/manifest.ts';
import { Interrupts, runProfile } from '../src/run/runJob.ts';
import { fetchStatus } from '../src/run/remoteChecks.ts';
import { testEnvironment, testMachine, waitUntil, writeFiles } from './helpers/fixtures.ts';
import { RsyncTransport } from './helpers/rsyncTransport.ts';

function setup(command = 'echo tests 1', extra: Record<string, unknown> = {}) {
  const env = testEnvironment();
  const source = join(env.root, 'source');
  writeFiles(source, { 'run.sh': command, 'data/file.txt': 'first', '.env': 'synthetic-excluded' });
  const path = join(env.root, 'project.json');
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, id: 'rsync-fixture', sourceRoot: source,
    sync: { include: ['**'], maxTotalMiB: 16, maxFileMiB: 16 },
    profiles: { test: { description: 'rsync fixture', kind: 'test', argv: ['bash', 'run.sh'], timeoutMinutes: 0.2,
      sourceTransfer: 'rsync', cache: { name: 'shared-fixture', maxGiB: 0.1 },
      success: { minTestCount: { pattern: 'tests (\\d+)', min: 1 } }, ...extra } } }));
  registerProject(env.paths, path, undefined, false);
  const transport = new RsyncTransport(env.remoteHome);
  const interrupts = new Interrupts();
  const request = { paths: env.paths, project: loadProject(env.paths, 'rsync-fixture'), profileName: 'test', machine: testMachine(),
    transport, sourceRoot: source, extraArgs: [], ignoreHeavyProcesses: false, interrupts,
    io: { stdout: env.stdout, stderr: env.stderr, status: (_line: string) => {} } };
  const owner = join(env.remoteRoot, 'cache/shared-fixture/.fleet-runner-sources/rsync-fixture');
  return { env, request, transport, source, owner, tree: join(owner, 'tree'), interrupts };
}

test('rsync requires an explicit bounded cache', () => {
  assert.throws(() => parseManifest({ schemaVersion: 1, id: 'demo', sync: { include: ['**'] },
    profiles: { test: { description: 'test', kind: 'check', argv: ['true'], timeoutMinutes: 1, sourceTransfer: 'rsync' } } }, 'fixture'), /named cache/);
});

test('rsync preserves quotes and spaces in the configured remote root', { timeout: 30000 }, async () => {
  const fixture = setup();
  fixture.request.machine = testMachine({ remoteRoot: "~/Quoted 'Fleet Runner.noindex" });
  try {
    const run = await runProfile(fixture.request);
    assert.equal(run.receipt.outcome, 'passed', JSON.stringify(run.receipt));
    assert.equal(run.receipt.remote.lockReleased, true);
  } finally { fixture.env.cleanup(); }
});

test('rsync cold and warm runs isolate execution and never retain job env', { timeout: 30000 }, async () => {
  const fixture = setup('test ! -e .env; echo changed-by-job > data/file.txt; echo "$PRIVATE_JOB_VALUE" > report.txt; echo tests 1', { artifacts: ['report.txt'] });
  fixture.request.machine = testMachine({ env: { PRIVATE_JOB_VALUE: 'synthetic-job-secret' } });
  chmodSync(join(fixture.source, 'run.sh'), 0o751);
  symlinkSync('data/file.txt', join(fixture.source, 'link.txt'));
  try {
    const cold = await runProfile(fixture.request);
    assert.equal(cold.receipt.outcome, 'passed', `${JSON.stringify(cold.receipt)}\n${readFileSync(join(cold.receiptPath, '..', 'rsync.log'), 'utf8')}`);
    assert.equal(cold.admission, 'admitted');
    assert.equal(cold.receipt.remote.lockReleased, true);
    assert.equal(readFileSync(join(fixture.tree, 'data/file.txt'), 'utf8'), 'first');
    assert.equal(statSync(join(fixture.tree, 'run.sh')).mode & 0o777, 0o751);
    assert.equal(existsSync(join(fixture.tree, '.env')), false);
    assert.equal(existsSync(join(fixture.tree, 'report.txt')), false);
    assert.deepEqual(readdirSync(fixture.owner).sort(), ['.fleet-source', 'tree']);
    assert.equal(existsSync(join(cold.receiptPath, '..', 'source.noindex')), false);
    const warm = await runProfile(fixture.request);
    assert.equal(warm.receipt.outcome, 'passed', JSON.stringify(warm.receipt));
    assert.ok(warm.receipt.source.transfer?.sentBytes !== undefined);
    assert.equal(readFileSync(join(fixture.source, 'data/file.txt'), 'utf8'), 'first');
    assert.equal(statSync(join(fixture.source, 'run.sh')).mode & 0o777, 0o751);
  } finally { fixture.env.cleanup(); }
});

test('rsync preserves one-edit delta, deletions, renames and fixes corrupted cache content', { timeout: 30000 }, async () => {
  const fixture = setup();
  writeFileSync(join(fixture.source, 'large.dat'), randomBytes(2 * 1024 * 1024));
  try {
    const cold = await runProfile(fixture.request);
    assert.equal(cold.receipt.outcome, 'passed', JSON.stringify(cold.receipt));
    writeFileSync(join(fixture.source, 'data/file.txt'), 'second');
    renameSync(join(fixture.source, 'run.sh'), join(fixture.source, 'renamed.sh'));
    writeFileSync(join(fixture.source, 'run.sh'), 'test -e renamed.sh; test ! -e large.dat; echo tests 1');
    rmSync(join(fixture.source, 'large.dat'));
    writeFileSync(join(fixture.tree, 'data/file.txt'), 'BROKEN');
    const next = await runProfile(fixture.request);
    assert.equal(next.receipt.outcome, 'passed', JSON.stringify(next.receipt));
    assert.equal(readFileSync(join(fixture.tree, 'data/file.txt'), 'utf8'), 'second');
    assert.equal(existsSync(join(fixture.tree, 'large.dat')), false);
    assert.equal(existsSync(join(fixture.tree, 'renamed.sh')), true);
    assert.ok((next.receipt.source.transfer?.sentBytes ?? Infinity) < (cold.receipt.source.transfer?.sentBytes ?? 0));
  } finally { fixture.env.cleanup(); }
});

test('editing the original during rsync aborts before command execution', { timeout: 30000 }, async () => {
  const fixture = setup('echo COMMAND_STARTED; echo tests 1');
  fixture.transport.beforeSync = () => writeFileSync(join(fixture.source, 'data/file.txt'), 'edited-after-plan');
  try {
    const run = await runProfile(fixture.request);
    // A protective stop, not a Fleet error; its exit code is unchanged.
    assert.equal(run.receipt.outcome, 'aborted', JSON.stringify(run.receipt));
    assert.deepEqual(run.receipt.abort, { reason: 'source-changed', path: 'data/file.txt' });
    assert.equal(run.exitCode, 2);
    assert.equal(run.admission, 'admitted');
    assert.equal(run.receipt.timing.remoteStartedAt, null);
    assert.equal(fixture.env.stdout.text.includes('COMMAND_STARTED'), false);
    assert.equal(run.receipt.remote.lockReleased, true);
  } finally { fixture.env.cleanup(); }
});

test('atomic editor replacement after staging aborts a successfully synced old snapshot', { timeout: 30000 }, async () => {
  const fixture = setup('echo COMMAND_STARTED; echo tests 1');
  fixture.transport.beforeSync = () => {
    writeFileSync(join(fixture.source, 'replacement.txt'), 'replacement');
    renameSync(join(fixture.source, 'replacement.txt'), join(fixture.source, 'data/file.txt'));
  };
  try {
    const run = await runProfile(fixture.request);
    assert.equal(run.receipt.outcome, 'aborted', JSON.stringify(run.receipt));
    assert.deepEqual(run.receipt.abort, { reason: 'source-changed', path: 'data/file.txt' });
    assert.equal(run.receipt.timing.remoteStartedAt, null);
    assert.equal(run.receipt.remote.lockReleased, true);
    assert.equal(readFileSync(join(fixture.tree, 'data/file.txt'), 'utf8'), 'first');
  } finally { fixture.env.cleanup(); }
});

test('corruption after rsync is refused before materialization or command start', { timeout: 30000 }, async () => {
  const fixture = setup('echo COMMAND_STARTED; echo tests 1');
  fixture.transport.beforeSync = () => {
    const jobs = join(fixture.env.remoteRoot, 'jobs');
    const job = readdirSync(jobs).find((name) => existsSync(join(jobs, name, 'meta/rsync-worker.py')));
    assert.ok(job);
    const worker = join(jobs, job, 'meta/rsync-worker.py');
    writeFileSync(worker, readFileSync(worker, 'utf8').replace('    verify_tree(tree, entries, parents)', "    open(os.path.join(tree, 'data/file.txt'), 'w').write('corrupt')\n    verify_tree(tree, entries, parents)"));
  };
  try {
    const run = await runProfile(fixture.request);
    // Remote verification failure is a genuine error, not a source-change stop.
    assert.equal(run.receipt.outcome, 'error', JSON.stringify(run.receipt));
    assert.equal(run.receipt.abort, null);
    assert.equal(run.receipt.timing.remoteStartedAt, null);
    assert.equal(run.receipt.remote.lockReleased, true);
    assert.equal(existsSync(fixture.tree), false);
  } finally { fixture.env.cleanup(); }
});

test('cancellation during a rate-limited rsync stops receiver before cleanup', { timeout: 30000 }, async () => {
  const fixture = setup('echo COMMAND_STARTED; echo tests 1');
  fixture.transport.extraArguments.push('--bwlimit=128');
  writeFileSync(join(fixture.source, 'large.dat'), randomBytes(2 * 1024 * 1024));
  try {
    const pending = runProfile(fixture.request);
    assert.equal(await waitUntil(() => existsSync(join(fixture.owner, 'dirty')), 10000), true);
    fixture.interrupts.trigger();
    const run = await pending;
    assert.equal(run.receipt.outcome, 'cancelled', JSON.stringify(run.receipt));
    assert.equal(run.receipt.remote.lockReleased, true);
    assert.equal(run.receipt.timing.remoteStartedAt, null);
    assert.equal((await fetchStatus(fixture.transport, fixture.request.machine)).lock.state, 'free');
    assert.equal(existsSync(join(fixture.env.remoteRoot, 'jobs', run.receipt.jobId, 'src')), false);
    fixture.transport.extraArguments.length = 0;
    const retry = await runProfile(fixture.request);
    assert.equal(retry.receipt.outcome, 'passed', JSON.stringify(retry.receipt));
    assert.equal(existsSync(join(fixture.owner, 'dirty')), false);
  } finally { fixture.env.cleanup(); }
});

test('nearly-full source cache uses disposable source and preserves unrelated dependencies', { timeout: 30000 }, async () => {
  const fixture = setup();
  const cache = join(fixture.env.remoteRoot, 'cache/shared-fixture');
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, 'dependency'), '');
  const dependencyBytes = Math.floor(0.1 * 1024 ** 3) - 1024;
  truncateSync(join(cache, 'dependency'), dependencyBytes);
  writeFiles(join(cache, '.fleet-runner-sources/other-project'), { '.fleet-source': 'other-project', 'tree/other': 'other-data' });
  writeFileSync(join(fixture.source, 'data/larger.dat'), Buffer.alloc(8192, 42));
  try {
    const run = await runProfile(fixture.request);
    assert.equal(run.receipt.outcome, 'passed', JSON.stringify(run.receipt));
    assert.equal(run.receipt.remote.lockReleased, true);
    assert.equal(existsSync(join(cache, 'dependency')), true);
    assert.equal(statSync(join(cache, 'dependency')).size, dependencyBytes);
    assert.equal(readFileSync(join(cache, '.fleet-runner-sources/other-project/tree/other'), 'utf8'), 'other-data');
    assert.equal(existsSync(fixture.tree), false);
    assert.match(readFileSync(join(run.receiptPath, '..', 'rsync.log'), 'utf8'), /disposable job source/);
  } finally { fixture.env.cleanup(); }
});

test('an already-over-limit shared cache refuses without deleting unrelated data', { timeout: 30_000 }, async () => {
  const fixture = setup();
  const cache = join(fixture.env.remoteRoot, 'cache/shared-fixture');
  mkdirSync(cache, { recursive: true });
  const dependency = join(cache, 'dependency');
  writeFileSync(dependency, '');
  const bytes = Math.floor(0.1 * 1024 ** 3) + 8192;
  truncateSync(dependency, bytes);
  try {
    const run = await runProfile(fixture.request);
    assert.notEqual(run.receipt.outcome, 'passed');
    assert.equal(run.receipt.timing.remoteStartedAt, null);
    assert.equal(run.receipt.remote.lockReleased, true);
    assert.equal(statSync(dependency).size, bytes);
    assert.match(readFileSync(join(run.receiptPath, '..', 'rsync.log'), 'utf8'), /unrelated dependencies were preserved/);
  } finally { fixture.env.cleanup(); }
});
