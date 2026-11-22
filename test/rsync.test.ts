// Real rsync protocol and supervisor tests: retained source remains separate
// from execution and command/env data, with exact files and bounded ownership.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, realpathSync, promises as fs, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadProject, registerProject } from '../src/registry.ts';
import { parseManifest } from '../src/schema/manifest.ts';
import { Interrupts, runProfile } from '../src/run/runJob.ts';
import { fetchStatus } from '../src/run/remoteChecks.ts';
import { testEnvironment, testMachine, waitUntil, writeFiles } from './helpers/fixtures.ts';
import { RsyncTransport } from './helpers/rsyncTransport.ts';
import { rsyncFileCacheArguments } from '../src/transport/rsyncArguments.ts';
import { sourceStageRoot } from '../src/run/sourceStage.ts';

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
  const owner = baselineOwner(env.remoteRoot, source);
  return { env, request, transport, source, owner, tree: join(owner, 'tree'), interrupts };
}

function baselineOwner(remoteRoot: string, source: string): string {
  const worktree = createHash('sha256').update(realpathSync(source)).digest('hex');
  return join(remoteRoot, 'cache/shared-fixture/.fleet-runner-worktrees/rsync-fixture', worktree);
}

function setReceiverCacheLimit(fixture: ReturnType<typeof setup>, maxKiB: number): void {
  // Exercise the actual receiver with a small allocated fixture. Profile
  // validation's 0.1 GiB minimum still applies to normal client requests.
  fixture.transport.beforeSync = () => {
    const jobs = join(fixture.env.remoteRoot, 'jobs');
    const job = readdirSync(jobs).find((name) => existsSync(join(jobs, name, 'meta/source-sync.json')));
    assert.ok(job);
    const config = join(jobs, job, 'meta/source-sync.json');
    const metadata = JSON.parse(readFileSync(config, 'utf8')) as Record<string, unknown>;
    writeFileSync(config, JSON.stringify({ ...metadata, cacheMaxKiB: maxKiB }));
  };
}

function allocatedKiB(directory: string): number {
  return Number(execFileSync('/usr/bin/du', ['-sk', directory], { encoding: 'utf8' }).split(/\s+/, 1)[0]);
}

test('rsync requires an explicit bounded cache', () => {
  assert.throws(() => parseManifest({ schemaVersion: 1, id: 'demo', sync: { include: ['**'] },
    profiles: { test: { description: 'test', kind: 'check', argv: ['true'], timeoutMinutes: 1, sourceTransfer: 'rsync' } } }, 'fixture'), /named cache/);
});

test('rsync SSH launch errors retain their code without exposing the route', () => {
  const fixture = setup();
  try {
    const result = spawnSync(process.execPath, [new URL('../src/transport/rsyncSsh.ts', import.meta.url).pathname, 'fleet-worker', 'fleet-runner-receiver'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: join(fixture.env.root, 'missing-ssh'), FLEET_RUNNER_RSYNC_SSH_ARGS: '[]', FLEET_RUNNER_RSYNC_RECEIVER: 'private-route-sentinel' },
    });
    assert.equal(result.status, 255);
    assert.match(result.stderr, /rsync SSH launch failed \(ENOENT\)/);
    assert.equal(result.stderr.includes('private-route-sentinel'), false);
    const bin = join(fixture.env.root, 'missing-ssh');
    mkdirSync(bin);
    writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nexit 73\n', { mode: 0o755 });
    const refused = spawnSync(process.execPath, [new URL('../src/transport/rsyncSsh.ts', import.meta.url).pathname, 'fleet-worker', 'fleet-runner-receiver'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: bin, FLEET_RUNNER_RSYNC_SSH_ARGS: '[]', FLEET_RUNNER_RSYNC_RECEIVER: 'private-route-sentinel' },
    });
    assert.equal(refused.status, 73);
    assert.match(refused.stderr, /rsync SSH ended \(73\)/);
    assert.equal(refused.stderr.includes('private-route-sentinel'), false);
  } finally { fixture.env.cleanup(); }
});

test('rsync receiver explains terminal refusal and worker signal while preserving failure codes', () => {
  const fixture = setup();
  try {
    const job = join(fixture.env.remoteRoot, 'jobs/diagnostic-fixture');
    mkdirSync(join(job, 'meta'), { recursive: true });
    writeFileSync(join(job, '.fleet-job'), '');
    writeFileSync(join(job, 'result'), 'reason=aborted\n');
    const receiver = new URL('../remote/rsync_receive.py', import.meta.url).pathname;
    const worker = join(job, 'meta/rsync-worker.py');
    const refused = spawnSync('python3', ['-B', receiver, job, worker], { encoding: 'utf8' });
    assert.equal(refused.status, 73);
    assert.match(refused.stderr, /job is terminal or source is already present/);
    rmSync(join(job, 'result'));
    writeFileSync(worker, 'import os, signal\nos.kill(os.getpid(), signal.SIGKILL)\n');
    const signalled = spawnSync('python3', ['-B', receiver, job, worker], { encoding: 'utf8' });
    assert.equal(signalled.status, 1);
    assert.match(signalled.stderr, /worker ended with signal 9/);
  } finally { fixture.env.cleanup(); }
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

test('native sender caching preserves receiver compatibility', { timeout: 30000, skip: !rsyncFileCacheArguments().includes('--cache') }, async () => {
  const fixture = setup();
  const receiver = join(fixture.env.root, 'receiver-without-cache-option');
  writeFileSync(receiver, '#!/bin/sh\nfor argument; do [ "$argument" != --cache ] || exit 64; done\necho invoked > "$0.invoked"\nexec /usr/bin/rsync "$@"\n', { mode: 0o700 });
  fixture.transport.beforeSync = () => {
    const jobs = join(fixture.env.remoteRoot, 'jobs');
    const job = readdirSync(jobs).find((name) => existsSync(join(jobs, name, 'meta/rsync-worker.py')));
    assert.ok(job);
    const worker = join(jobs, job, 'meta/rsync-worker.py');
    const original = readFileSync(worker, 'utf8');
    assert.ok(original.includes("['/usr/bin/rsync', *receiver_arguments"));
    writeFileSync(worker, original.replace("['/usr/bin/rsync', *receiver_arguments", `[${JSON.stringify(receiver)}, *receiver_arguments`));
  };
  try {
    const run = await runProfile(fixture.request);
    assert.equal(run.receipt.outcome, 'passed', JSON.stringify(run.receipt));
    assert.equal(run.receipt.remote.lockReleased, true);
    assert.equal(run.receipt.remote.processesRemaining, false);
    assert.equal(readFileSync(`${receiver}.invoked`, 'utf8').trim(), 'invoked');
  } finally { fixture.env.cleanup(); }
});

test('allocated bytes of a private source clone can prevent baseline retention', { timeout: 30000 }, async () => {
  const fixture = setup('test -f data/tiny-127 && echo tests 1');
  try {
    for (let index = 0; index < 128; index++) writeFileSync(join(fixture.source, 'data', `tiny-${index}`), 'x');
    setReceiverCacheLimit(fixture, 64);
    const run = await runProfile(fixture.request);
    assert.equal(run.receipt.outcome, 'passed', JSON.stringify(run.receipt));
    assert.match(readFileSync(join(run.receiptPath, '..', 'rsync.log'), 'utf8'), /source cache full; using disposable job source/);
    assert.equal(existsSync(fixture.tree), false);
    assert.equal(existsSync(join(fixture.env.remoteRoot, 'jobs', run.receipt.jobId, 'source-baseline.noindex')), false);
    assert.equal(run.receipt.remote.lockReleased, true);
  } finally { fixture.env.cleanup(); }
});

test('different worktrees reuse only their own verified source baselines', { timeout: 30000 }, async () => {
  const fixture = setup('echo tests 1', { cache: { name: 'shared-fixture', maxGiB: 0.1, concurrent: true } });
  const other = join(fixture.env.root, 'other-source');
  writeFiles(other, { 'run.sh': 'test "$(cat data/file.txt)" = other; echo tests 1', 'data/file.txt': 'other' });
  writeFileSync(join(fixture.source, 'large.dat'), randomBytes(256 * 1024));
  writeFileSync(join(other, 'large.dat'), randomBytes(256 * 1024));
  const legacy = join(fixture.env.remoteRoot, 'cache/shared-fixture/.fleet-runner-sources/rsync-fixture');
  writeFiles(legacy, { '.fleet-source': 'rsync-fixture', 'tree/legacy.txt': 'previous format' });
  try {
    const first = await runProfile(fixture.request);
    const second = await runProfile({ ...fixture.request, sourceRoot: other });
    assert.equal(first.receipt.outcome, 'passed', JSON.stringify(first.receipt));
    assert.equal(second.receipt.outcome, 'passed', JSON.stringify(second.receipt));
    assert.equal(readFileSync(join(fixture.tree, 'data/file.txt'), 'utf8'), 'first');
    assert.equal(readFileSync(join(baselineOwner(fixture.env.remoteRoot, other), 'tree/data/file.txt'), 'utf8'), 'other');
    assert.equal(readFileSync(join(legacy, 'tree/legacy.txt'), 'utf8'), 'previous format');
    const warm = await runProfile(fixture.request);
    assert.equal(warm.receipt.outcome, 'passed', JSON.stringify(warm.receipt));
    assert.ok((warm.receipt.source.transfer?.sentBytes ?? Infinity) < (first.receipt.source.transfer?.sentBytes ?? 0) / 2);
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
    assert.deepEqual(readdirSync(fixture.owner), ['tree']);
    assert.equal(existsSync(join(cold.receiptPath, '..', 'source.noindex')), false);
    const warm = await runProfile(fixture.request);
    assert.equal(warm.receipt.outcome, 'passed', JSON.stringify(warm.receipt));
    assert.ok(warm.receipt.source.transfer?.sentBytes !== undefined);
    assert.equal(readFileSync(join(fixture.source, 'data/file.txt'), 'utf8'), 'first');
    assert.equal(statSync(join(fixture.source, 'run.sh')).mode & 0o777, 0o751);
  } finally { fixture.env.cleanup(); }
});

test('rsync stages outside results and TMPDIR, then retains only run evidence', { timeout: 30000 }, async () => {
  const fixture = setup('echo report > report.txt; echo tests 1', { artifacts: ['report.txt'] });
  const results = join(fixture.env.root, 'returned.noindex');
  const scratch = join(fixture.env.root, 'tmp.noindex');
  mkdirSync(results);
  mkdirSync(scratch);
  const originalTmp = process.env['TMPDIR'];
  process.env['TMPDIR'] = scratch;
  try {
    const run = await runProfile({ ...fixture.request, paths: { ...fixture.env.paths, runsDir: results } });
    assert.equal(run.receipt.outcome, 'passed', JSON.stringify(run.receipt));
    assert.equal(fixture.transport.sourceDirectory, join(sourceStageRoot(fixture.env.paths), run.receipt.jobId, 'source.noindex'));
    assert.deepEqual(readdirSync(sourceStageRoot(fixture.env.paths)), []);
    assert.deepEqual(readdirSync(scratch), []);
    assert.equal(existsSync(join(results, run.receipt.jobId, 'source.noindex')), false);
    assert.equal(readFileSync(join(results, run.receipt.jobId, 'artifacts/report.txt'), 'utf8').trim(), 'report');
    assert.equal(existsSync(join(results, run.receipt.jobId, 'rsync.log')), true);
    assert.equal(existsSync(run.receiptPath), true);
    assert.equal(run.receipt.remote.lockReleased, true);
    assert.equal(run.receipt.remote.processesRemaining, false);
  } finally {
    if (originalTmp === undefined) delete process.env['TMPDIR']; else process.env['TMPDIR'] = originalTmp;
    fixture.env.cleanup();
  }
});

test('overlapping uploads have separate disposable controller copies', { timeout: 30000 }, async () => {
  const fixture = setup('echo tests 1', { cache: { name: 'shared-fixture', maxGiB: 0.1, concurrent: true } });
  const machine = testMachine();
  fixture.request.machine = { ...machine, limits: { ...machine.limits, maxConcurrentJobs: 2 } };
  try {
    writeFileSync(join(fixture.source, 'large.dat'), randomBytes(256 * 1024));
    const cold = await runProfile(fixture.request);
    assert.equal(cold.receipt.outcome, 'passed', JSON.stringify(cold.receipt));
    const runs = await Promise.all([runProfile(fixture.request), runProfile(fixture.request)]);
    for (const run of runs) {
      assert.equal(run.receipt.outcome, 'passed', JSON.stringify(run.receipt));
      assert.equal(run.receipt.remote.lockReleased, true);
      assert.equal(run.receipt.remote.processesRemaining, false);
      assert.match(readFileSync(join(run.receiptPath, '..', 'rsync.log'), 'utf8'), /seeded private source/);
      assert.ok((run.receipt.source.transfer?.sentBytes ?? Infinity) < (cold.receipt.source.transfer?.sentBytes ?? 0) / 2);
    }
    assert.equal(new Set(fixture.transport.sourceDirectories).size, 3);
    assert.deepEqual(readdirSync(sourceStageRoot(fixture.env.paths)), []);
  } finally { fixture.env.cleanup(); }
});

test('source-space refusal checks staging rather than the results volume', { timeout: 30000 }, async () => {
  const fixture = setup();
  const available = await fs.statfs(fixture.env.root);
  let checked: unknown;
  const statfs = mock.method(fs, 'statfs', async (path: unknown) => {
    checked = path;
    return { ...available, bavail: 0 };
  });
  try {
    await assert.rejects(runProfile(fixture.request), /source staging volume has only/);
    assert.equal(checked, sourceStageRoot(fixture.env.paths));
    assert.deepEqual(readdirSync(sourceStageRoot(fixture.env.paths)), []);
    assert.equal(existsSync(join(fixture.env.remoteRoot, 'jobs')), false);
  } finally { statfs.mock.restore(); fixture.env.cleanup(); }
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
    assert.deepEqual(readdirSync(sourceStageRoot(fixture.env.paths)), []);
  } finally { fixture.env.cleanup(); }
});

test('cancellation during a rate-limited rsync stops receiver before cleanup', { timeout: 30000 }, async () => {
  const fixture = setup('echo COMMAND_STARTED; echo tests 1');
  fixture.transport.extraArguments.push('--bwlimit=128');
  writeFileSync(join(fixture.source, 'large.dat'), randomBytes(2 * 1024 * 1024));
  try {
    const pending = runProfile(fixture.request);
    const jobs = join(fixture.env.remoteRoot, 'jobs');
    assert.equal(await waitUntil(() => existsSync(jobs) && readdirSync(jobs).some((job) => existsSync(join(jobs, job, 'source-rsync.dirty'))), 10000), true);
    fixture.interrupts.trigger();
    const run = await pending;
    assert.equal(run.receipt.outcome, 'cancelled', JSON.stringify(run.receipt));
    assert.equal(run.receipt.remote.lockReleased, true);
    assert.equal(run.receipt.timing.remoteStartedAt, null);
    assert.equal((await fetchStatus(fixture.transport, fixture.request.machine)).lock.state, 'free');
    assert.deepEqual(readdirSync(sourceStageRoot(fixture.env.paths)), []);
    assert.equal(existsSync(join(fixture.env.remoteRoot, 'jobs', run.receipt.jobId, 'src')), false);
    fixture.transport.extraArguments.length = 0;
    const retry = await runProfile(fixture.request);
    assert.equal(retry.receipt.outcome, 'passed', JSON.stringify(retry.receipt));
    assert.equal(existsSync(join(fixture.tree, 'large.dat')), true);
  } finally { fixture.env.cleanup(); }
});

test('nearly-full source cache uses disposable source and preserves unrelated dependencies', { timeout: 30000 }, async () => {
  const fixture = setup();
  const cache = join(fixture.env.remoteRoot, 'cache/shared-fixture');
  try {
    mkdirSync(fixture.owner, { recursive: true });
    const dependencyBytes = 32 * 1024;
    writeFileSync(join(cache, 'dependency'), Buffer.alloc(dependencyBytes, 42));
    writeFiles(join(cache, '.fleet-runner-sources/other-project'), { '.fleet-source': 'other-project', 'tree/other': 'other-data' });
    writeFileSync(join(fixture.source, 'data/larger.dat'), Buffer.alloc(8192, 42));
    setReceiverCacheLimit(fixture, allocatedKiB(cache));
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
  const dependency = join(cache, 'dependency');
  try {
    mkdirSync(cache, { recursive: true });
    const bytes = 32 * 1024;
    writeFileSync(dependency, Buffer.alloc(bytes, 42));
    setReceiverCacheLimit(fixture, allocatedKiB(cache) - 1);
    const run = await runProfile(fixture.request);
    assert.notEqual(run.receipt.outcome, 'passed');
    assert.equal(run.receipt.timing.remoteStartedAt, null);
    assert.equal(run.receipt.remote.lockReleased, true);
    assert.equal(statSync(dependency).size, bytes);
    assert.match(readFileSync(join(run.receiptPath, '..', 'rsync.log'), 'utf8'), /unrelated dependencies were preserved/);
  } finally { fixture.env.cleanup(); }
});
