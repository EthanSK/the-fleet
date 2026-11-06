// Capacity qualification uses the real supervisor with independent disposable
// source snapshots. File gates make overlap/cancellation deterministic without
// adding production delays or relying on a guessed job duration.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseManifest } from '../src/schema/manifest.ts';
import { loadProject, registerProject, saveMachines } from '../src/registry.ts';
import { Interrupts, runProfile, type RunRequest } from '../src/run/runJob.ts';
import { fetchPreflight, fetchStatus, runControl } from '../src/run/remoteChecks.ts';
import { cancelCommand, lockCommand, statusCommand } from '../src/cli/runCommands.ts';
import { evaluatePreflight, parsePreflight } from '../src/run/preflight.ts';
import { Coordinator, type CoordinatorDependencies } from '../src/service/coordinator.ts';
import { claimsConflict, parseClaim, profileWorkload } from '../src/run/capacity.ts';
import { RunNotStartedError } from '../src/errors.ts';
import { report } from './helpers/serviceFixture.ts';
import { testEnvironment, testMachine, waitUntil, writeFiles } from './helpers/fixtures.ts';
import { RsyncTransport } from './helpers/rsyncTransport.ts';

function fixture() {
  const env = testEnvironment();
  const base = testMachine();
  const machine = { ...base, limits: { ...base.limits, maxConcurrentJobs: 2 } };
  const transport = new RsyncTransport(env.remoteHome);
  function request(id: string, extra: Record<string, unknown> = {}, projectId = id): RunRequest {
    const source = join(env.root, id);
    writeFiles(source, { 'run.sh': 'echo started > "$GATE/started-$LABEL"; while [ ! -f "$GATE/release-$LABEL" ]; do sleep 0.1; done; echo tests 1; echo "$LABEL" > result.txt', 'content.txt': id });
    const manifest = join(env.root, id + '.json');
    writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, id: projectId, sourceRoot: source, sync: { include: ['**'] }, profiles: { test: { description: id, kind: 'test', argv: ['bash', 'run.sh'], timeoutMinutes: 0.5, env: { GATE: env.root, LABEL: id }, artifacts: ['result.txt'], success: { minTestCount: { pattern: 'tests (\\d+)', min: 1 } }, ...extra } } }));
    registerProject(env.paths, manifest, undefined, true);
    return { paths: env.paths, project: loadProject(env.paths, projectId), profileName: 'test', machine, transport, sourceRoot: source, extraArgs: [], ignoreHeavyProcesses: false, interrupts: new Interrupts(), io: { stdout: env.stdout, stderr: env.stderr, status() {} } };
  }
  return { env, machine, transport, request, started: (id: string) => waitUntil(() => existsSync(join(env.root, 'started-' + id)), 10000), release: (id: string) => writeFileSync(join(env.root, 'release-' + id), '') };
}

function staleShared(f: ReturnType<typeof fixture>, jobId: string): string {
  const directory = join(f.env.remoteRoot, 'locks/shared', jobId);
  const job = join(f.env.remoteRoot, 'jobs', jobId);
  mkdirSync(directory, { recursive: true }); mkdirSync(job, { recursive: true });
  writeFileSync(join(job, '.fleet-job'), '');
  writeFileSync(join(directory, 'owner'), 'job_id=' + jobId + '\nlabel=fixture/test\nstarted=1\nsupervisor_pid=99999999\nsupervisor_start=gone\njob_pgid=99999999\njob_dir=' + job + '\n');
  return directory;
}

test('shared jobs overlap, slots bound admission, and cancelling one preserves its neighbour', { timeout: 30000 }, async () => {
  const f = fixture();
  const a = f.request('first'), b = f.request('second');
  let first: ReturnType<typeof runProfile> | undefined, second: ReturnType<typeof runProfile> | undefined;
  try {
    first = runProfile(a); assert.equal(await f.started('first'), true);
    second = runProfile(b); assert.equal(await f.started('second'), true);
    const state = await fetchPreflight(f.transport, f.machine, [], []);
    assert.equal(state.sharedLocks?.length, 2);
    assert.equal(evaluatePreflight(state, f.machine, a.project.manifest.profiles['test'], { ignoreHeavyProcesses: false, nowEpoch: Date.now() / 1000 }).refusals.some((r) => r.kind === 'busy'), true);
    a.interrupts?.trigger();
    const stopped = await first;
    assert.equal(stopped.receipt.outcome, 'cancelled');
    assert.equal(stopped.receipt.remote.lockReleased, true);
    assert.equal((await fetchPreflight(f.transport, f.machine, [], [])).sharedLocks?.length, 1);
    f.release('second');
    const survivor = await second;
    assert.equal(survivor.receipt.outcome, 'passed', JSON.stringify(survivor.receipt));
    assert.equal(readFileSync(join(survivor.receiptPath, '..', 'artifacts/result.txt'), 'utf8'), 'second\n');
  } finally { a.interrupts?.trigger(); b.interrupts?.trigger(); await Promise.allSettled([first, second]); f.env.cleanup(); }
});

for (const [name, extra] of [ ['port', { resources: ['port:4200'] }], ['unsafe cache', { cache: { name: 'shared', maxGiB: 0.1 } }], ['desktop', { requires: { guiSession: true } }] ] as const) {
  test('shared admission protects the same ' + name, { timeout: 30000 }, async () => {
    const f = fixture(); const a = f.request('first', extra), b = f.request('second', extra);
    let first: ReturnType<typeof runProfile> | undefined;
    try {
      first = runProfile(a); assert.equal(await f.started('first'), true);
      const refused = await runProfile(b);
      assert.equal(refused.admission, 'refused', JSON.stringify(refused.receipt));
      assert.equal(existsSync(join(f.env.root, 'started-second')), false);
      f.release('first'); assert.equal((await first).receipt.outcome, 'passed');
    } finally { a.interrupts?.trigger(); await Promise.allSettled([first]); f.env.cleanup(); }
  });
}

test('same named concurrent rsync cache supports isolated overlapping jobs and protects live data from retention', { timeout: 30000 }, async () => {
  const f = fixture(); const extra = { cache: { name: 'shared', maxGiB: 0.1, concurrent: true }, sourceTransfer: 'rsync' };
  const a = f.request('first', extra, 'same-project'), b = f.request('second', extra, 'same-project');
  let first: ReturnType<typeof runProfile> | undefined, second: ReturnType<typeof runProfile> | undefined;
  try {
    first = runProfile(a); assert.equal(await f.started('first'), true);
    second = runProfile(b); assert.equal(await f.started('second'), true);
    const cache = join(f.env.remoteRoot, 'cache/shared');
    // A real allocated file crosses the existing retention limit after both
    // transfers; the first completed job must not evict a live neighbour.
    writeFileSync(join(cache, 'large'), Buffer.alloc(110 * 1024 * 1024, 1));
    f.release('first'); assert.equal((await first).receipt.outcome, 'passed');
    assert.equal(existsSync(join(cache, 'large')), true);
    f.release('second'); assert.equal((await second).receipt.outcome, 'passed');
    assert.equal(existsSync(cache), false);
    assert.equal(readFileSync(join(a.sourceRoot, 'content.txt'), 'utf8'), 'first');
    assert.equal(readFileSync(join(b.sourceRoot, 'content.txt'), 'utf8'), 'second');
  } finally { a.interrupts?.trigger(); b.interrupts?.trigger(); await Promise.allSettled([first, second]); f.env.cleanup(); }
});

test('a concurrent cache over its retention cap still accepts isolated rsync source', { timeout: 30000 }, async () => {
  const f = fixture();
  const extra = { cache: { name: 'shared', maxGiB: 0.1, concurrent: true }, sourceTransfer: 'rsync' };
  const a = f.request('first', extra, 'same-project'), b = f.request('second', extra, 'same-project');
  let first: ReturnType<typeof runProfile> | undefined, second: ReturnType<typeof runProfile> | undefined;
  try {
    first = runProfile(a); assert.equal(await f.started('first'), true);
    const dependency = join(f.env.remoteRoot, 'cache/shared/dependency');
    writeFileSync(dependency, Buffer.alloc(110 * 1024 * 1024, 42));
    second = runProfile(b); assert.equal(await f.started('second'), true, f.env.stderr.text);
    f.release('second');
    const result = await second;
    assert.equal(result.receipt.outcome, 'passed', JSON.stringify(result.receipt));
    assert.match(readFileSync(join(result.receiptPath, '..', 'rsync.log'), 'utf8'), /disposable job source/);
    assert.equal(statSync(dependency).size, 110 * 1024 * 1024, 'the active neighbour still owns its dependency');
    f.release('first'); assert.equal((await first).receipt.outcome, 'passed');
  } finally { a.interrupts?.trigger(); b.interrupts?.trigger(); await Promise.allSettled([first, second]); f.env.cleanup(); }
});

test('cache measurement tolerates a real entry disappearing after the directory scan', () => {
  const f = fixture();
  try {
    // Execute the actual production helper, with a deterministic filesystem
    // race: the walk lists a real file and a neighbour deletes it before stat.
    const directory = join(f.env.root, 'measurement'); mkdirSync(directory);
    execFileSync('python3', ['-c', `import ast, os, stat, sys
source = ast.parse(open(sys.argv[1]).read())
function = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == 'cache_bytes')
namespace = {'os': os, 'stat': stat, 'active': lambda: None}
exec(compile(ast.Module(body=[function], type_ignores=[]), sys.argv[1], 'exec'), namespace)
directory = sys.argv[2]
open(os.path.join(directory, 'stable'), 'wb').write(b'1234')
open(os.path.join(directory, 'vanishing'), 'wb').write(b'gone')
walk = os.walk
def raced_walk(*args, **kwargs):
    for parent, directories, files in walk(*args, **kwargs):
        if 'vanishing' in files:
            os.unlink(os.path.join(parent, 'vanishing'))
        yield parent, directories, files
os.walk = raced_walk
assert namespace['cache_bytes'](directory) == 4
`, new URL('../remote/rsync_worker.py', import.meta.url).pathname, directory]);
  } finally { f.env.cleanup(); }
});

test('exclusive maintenance waits for shared jobs and exact stale shared recovery preserves neighbours', { timeout: 30000 }, async () => {
  const f = fixture(); const a = f.request('first'); let first: ReturnType<typeof runProfile> | undefined;
  try {
    first = runProfile(a); assert.equal(await f.started('first'), true);
    const blocked = await runControl(f.transport, f.machine, 'clear-stale', 'unknown-job');
    assert.equal(blocked.result, 'busy');
    f.release('first'); await first;
    const directory = join(f.env.remoteRoot, 'locks/shared/stale-job');
    mkdirSync(directory, { recursive: true });
    const job = join(f.env.remoteRoot, 'jobs/stale-job'); mkdirSync(job, { recursive: true }); writeFileSync(join(job, '.fleet-job'), '');
    writeFileSync(join(directory, 'owner'), 'job_id=stale-job\nlabel=fixture/test\nstarted=1\nsupervisor_pid=99999999\nsupervisor_start=gone\njob_pgid=99999999\njob_dir=' + job + '\n');
    assert.equal((await runControl(f.transport, f.machine, 'reap-stale', 'stale-job')).result, 'cleared');
    assert.equal((await fetchPreflight(f.transport, f.machine, [], [])).sharedLocks?.length, 0);
  } finally { a.interrupts?.trigger(); await Promise.allSettled([first]); f.env.cleanup(); }
});

test('status lists shared jobs while stale cleanup refuses to overlap a running neighbour', { timeout: 30000 }, async () => {
  const f = fixture(); const request = f.request('neighbour'); let running: ReturnType<typeof runProfile> | undefined;
  try {
    saveMachines(f.env.paths, { schemaVersion: 1, machines: [f.machine] });
    running = runProfile(request); assert.equal(await f.started('neighbour'), true);
    const stale = staleShared(f, 'abandoned-job');
    const remote = await fetchStatus(f.transport, f.machine);
    assert.equal(remote.lock.state, 'free'); assert.equal(remote.sharedLocks?.length, 2);
    await statusCommand(f.env.context, ['--machine', f.machine.id]);
    assert.match(f.env.stdout.text, /abandoned-job/); assert.match(f.env.stdout.text, /neighbour\/test/);
    assert.match(f.env.stdout.text, /--job abandoned-job/); assert.doesNotMatch(f.env.stdout.text, /mini is free/);
    assert.equal((await runControl(f.transport, f.machine, 'clear-stale', 'abandoned-job')).result, 'busy');
    assert.equal(existsSync(stale), true);
    const survivor = await fetchStatus(f.transport, f.machine);
    assert.equal(survivor.sharedLocks?.filter((entry) => entry.state === 'busy').length, 1);
    f.release('neighbour'); assert.equal((await running).receipt.outcome, 'passed');
    assert.equal((await runControl(f.transport, f.machine, 'clear-stale', 'abandoned-job')).result, 'cleared');
    assert.equal(existsSync(stale), false);
  } finally { request.interrupts?.trigger(); await Promise.allSettled([running]); f.env.cleanup(); }
});

test('unscoped shared recovery asks for an exact job and keeps both abandoned records', async () => {
  const f = fixture();
  try {
    saveMachines(f.env.paths, { schemaVersion: 1, machines: [f.machine] });
    const first = staleShared(f, 'first-abandoned'), second = staleShared(f, 'second-abandoned');
    await assert.rejects(lockCommand(f.env.context, ['clear', '--machine', f.machine.id]), /Specify one with --job/);
    await assert.rejects(cancelCommand(f.env.context, ['--machine', f.machine.id]), /Specify one with --job/);
    assert.equal(existsSync(first), true); assert.equal(existsSync(second), true);
    await lockCommand(f.env.context, ['clear', '--machine', f.machine.id, '--job', 'first-abandoned']);
    assert.equal(existsSync(first), false); assert.equal(existsSync(second), true);
  } finally { f.env.cleanup(); }
});

test('one coordinator shares aliases, drains admission, and retains uncertain claims across restart', async () => {
  const f = fixture();
  const dependencies: CoordinatorDependencies = { machines: () => [f.machine, { ...f.machine, id: 'alias' }], inspect: async (machine) => ({ machine, observedAt: new Date().toISOString(), report: report('physical') }), localFingerprint: async () => 'dispatcher', now: Date.now, route: () => ({ target: 'fixture', host: 'localhost', user: 'tester', port: 22, path: 'internet' }), execute: async () => { throw Error('unused'); } };
  const c = new Coordinator(f.env.paths, dependencies);
  type Lease = { token: string; reservation: { id: string }; connection?: unknown; ready: boolean };
  const shared = { mode: 'shared', resources: [] } as const;
  try {
    const first = await c.reserve('first', 'test', ['mini'], 180, shared) as Lease;
    const second = await c.reserve('second', 'test', ['alias'], 180, shared) as Lease;
    await assert.rejects(c.reserve('third', 'test', ['mini'], 180, shared));
    const draining = await c.reserve('maintenance', 'drain', ['mini'], 180, { mode: 'drain', resources: [] }) as Lease;
    assert.equal(draining.connection, undefined); assert.equal(draining.ready, false);
    await assert.rejects(c.reserve('fourth', 'test', ['mini'], 180, shared));
    assert.equal((await c.activate(draining.reservation.id, draining.token) as { ready: boolean }).ready, false);
    await c.release(first.reservation.id, first.token, true); await c.release(second.reservation.id, second.token, true);
    assert.equal((await c.activate(draining.reservation.id, draining.token) as { ready: boolean }).ready, true);
    const restarted = new Coordinator(f.env.paths, dependencies);
    await assert.rejects(restarted.reserve('fifth', 'test', ['alias'], 180, shared));
    await restarted.release(draining.reservation.id, draining.token);
    assert.equal((await restarted.reserve('sixth', 'test', ['mini'], 180, shared) as Lease).ready, true);
  } finally { f.env.cleanup(); }
});

test('capacity schema and cache conflicts keep unsafe clients serialized', () => {
  assert.equal(claimsConflict(parseClaim({ mode: 'shared', resources: [], cache: { name: 'aimvs', concurrent: true } }), parseClaim({ mode: 'shared', resources: [], cache: { name: 'aimvs' } })), true);
  assert.throws(() => parseClaim({ mode: 'other', resources: [] }));
  assert.throws(() => parseManifest({ schemaVersion: 1, id: 'demo', sync: { include: ['**'] }, profiles: { check: { description: 'check', kind: 'check', argv: ['true'], timeoutMinutes: 1, cache: { name: 'demo', maxGiB: 1, concurrent: 'yes' } } } }, 'fixture'));
});

for (const failure of ['preflight', 'source-plan'] as const) {
  test('a ' + failure + ' refusal releases only the never-started run while a neighbour remains', async () => {
    const f = fixture();
    const neighbour = 'a'.repeat(24);
    const neighbourJob = 'neighbour-job';
    const observation = report('physical', { sharedLocks: [{ state: 'busy', jobId: neighbourJob, label: 'neighbour/test', orphaned: false }], missingBaseTools: ['fixture-missing-tool'] });
    const request = f.request('refused');
    // Restarted work is deliberately retained: this refusal must neither
    // consume its second slot forever nor release the neighbour's ownership.
    writeFileSync(join(f.env.paths.home, 'reservations.json'), JSON.stringify([{ id: neighbour, machineId: f.machine.id, fingerprint: 'physical', owner: 'neighbour', label: 'neighbour/test', kind: 'managed',
      claim: { mode: 'shared', resources: [] }, jobId: neighbourJob, createdAt: new Date().toISOString(), expiresAt: null, tokenHash: 'a'.repeat(64), state: 'active' }]));
    const c = new Coordinator(f.env.paths, { machines: () => [f.machine], inspect: async (machine) => ({ machine, observedAt: new Date().toISOString(), report: observation }), localFingerprint: async () => 'dispatcher', now: Date.now,
      route: () => ({ target: 'fixture', host: 'localhost', user: 'test', port: 22, path: 'internet' }), execute: runProfile });
    try {
      await assert.rejects(c.runOne('refused', 'b'.repeat(24), { ...request, preflightReport: observation, ...(failure === 'source-plan' ? { sourceRoot: join(f.env.root, 'absent') } : {}) }), RunNotStartedError);
      const leases = (await c.state(true) as { reservations: { id: string; state: string }[] }).reservations;
      assert.deepEqual(leases.map((lease) => lease.id), [neighbour]);
      assert.equal(leases[0]?.state, 'unverified');
      assert.equal(existsSync(join(f.env.root, 'started-refused')), false);
    } finally { f.env.cleanup(); }
  });
}


test('unknown remote shared work counts alongside external claims', async () => {
  const f = fixture(); let observation = report('physical');
  const c = new Coordinator(f.env.paths, { machines: () => [f.machine], inspect: async (machine) => ({ machine, observedAt: new Date().toISOString(), report: observation }), localFingerprint: async () => 'dispatcher', now: Date.now, route: () => ({ target: 'fixture', host: 'localhost', user: 'test', port: 22, path: 'internet' }), execute: async () => { throw Error('unused'); } });
  try {
    await c.reserve('external', 'own SSH', ['mini'], 180, { mode: 'shared', resources: [] });
    observation = report('physical', { sharedLocks: [{ state: 'busy', jobId: 'remote-job', label: 'other/test', orphaned: false }] });
    const state = await c.state(true) as { workers: { capacity: { used: number; free: number }; available: boolean }[] };
    assert.equal(state.workers[0]?.capacity.used, 2); assert.equal(state.workers[0]?.capacity.free, 0);
    await assert.rejects(c.reserve('another', 'test', ['mini'], 180, { mode: 'shared', resources: [] }));
  } finally { f.env.cleanup(); }
});

test('a shared startup record retains its preallocated identity without consuming a second slot', async () => {
  const f = fixture();
  const jobId = 'starting-job';
  const leaseId = 'a'.repeat(24);
  try {
    mkdirSync(join(f.env.remoteRoot, 'locks/shared', jobId), { recursive: true });
    const observation = await fetchPreflight(f.transport, f.machine, [], []);
    assert.equal(observation.sharedLocks?.[0]?.state, 'busy');
    assert.equal(observation.sharedLocks?.[0]?.jobId, jobId);
    mkdirSync(f.env.paths.home, { recursive: true, mode: 0o700 });
    writeFileSync(join(f.env.paths.home, 'reservations.json'), JSON.stringify([{ id: leaseId, machineId: f.machine.id, fingerprint: observation.fingerprint, owner: 'starting', label: 'starting/test', kind: 'managed',
      claim: { mode: 'shared', resources: [] }, jobId, createdAt: new Date().toISOString(), expiresAt: null, tokenHash: 'a'.repeat(64), state: 'active' }]));
    const c = new Coordinator(f.env.paths, { machines: () => [f.machine], inspect: async (machine) => ({ machine, observedAt: new Date().toISOString(), report: observation }), localFingerprint: async () => 'dispatcher', now: Date.now,
      route: () => ({ target: 'fixture', host: 'localhost', user: 'test', port: 22, path: 'internet' }), execute: runProfile });
    const state = await c.state(true) as { workers: { capacity: { used: number; free: number }; available: boolean }[] };
    assert.equal(state.workers[0]?.capacity.used, 1);
    assert.equal(state.workers[0]?.capacity.free, 1);
    assert.equal(state.workers[0]?.available, true);
  } finally { f.env.cleanup(); }
});

test('a shared record that disappears during a scan is not counted as occupied', () => {
  const f = fixture();
  try {
    const observation = report('physical', { sharedLocks: [{ state: 'free' }] });
    assert.deepEqual(evaluatePreflight(observation, f.machine, undefined, { ignoreHeavyProcesses: false, nowEpoch: Date.now() / 1000 }).refusals, []);
    assert.deepEqual(parsePreflight('shared_lock=free\ndone=1\n').sharedLocks, []);
  } finally { f.env.cleanup(); }
});

test('orphaned process groups are not reported as verified managed CPU work', async () => {
  const f = fixture();
  try {
    const lock = join(f.env.remoteRoot, 'locks/shared/orphaned-job'); mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'owner'), 'job_id=orphaned-job\nlabel=fixture/test\nstarted=1\nsupervisor_pid=99999999\nsupervisor_start=gone\njob_pgid=' + process.pid + '\njob_dir=' + join(f.env.remoteRoot, 'jobs/orphaned-job') + '\n');
    const observation = await fetchPreflight(f.transport, f.machine, [], []);
    assert.equal(observation.managedPgids?.includes(process.pid), false);
  } finally { f.env.cleanup(); }
});


test('an exact cancellation never falls through to an unrelated exclusive job', { timeout: 30000 }, async () => {
  const f = fixture(); const a = f.request('first', { exclusive: true }); let first: ReturnType<typeof runProfile> | undefined;
  try {
    first = runProfile(a); assert.equal(await f.started('first'), true);
    assert.equal((await runControl(f.transport, f.machine, 'cancel', 'not-this-job')).result, 'unverified');
    assert.equal((await fetchPreflight(f.transport, f.machine, [], [])).lock.state, 'busy');
    f.release('first'); assert.equal((await first).receipt.outcome, 'passed');
  } finally { a.interrupts?.trigger(); await Promise.allSettled([first]); f.env.cleanup(); }
});


test('retention preserves a recorded cache user after inherited descriptors were lost', { timeout: 30000 }, async () => {
  const f = fixture(); const a = f.request('first', { cache: { name: 'shared', maxGiB: 0.1, concurrent: true } }); let first: ReturnType<typeof runProfile> | undefined;
  try {
    first = runProfile(a); assert.equal(await f.started('first'), true);
    const cache = join(f.env.remoteRoot, 'cache/shared');
    const lock = join(f.env.remoteRoot, 'locks/shared/unverified-job'); mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'owner'), 'job_id=unverified-job\ncache_name=shared\nsupervisor_pid=99999999\nsupervisor_start=gone\n');
    writeFileSync(join(cache, 'large'), Buffer.alloc(110 * 1024 * 1024, 1));
    f.release('first'); assert.equal((await first).receipt.outcome, 'passed');
    assert.equal(existsSync(join(cache, 'large')), true);
  } finally { a.interrupts?.trigger(); await Promise.allSettled([first]); f.env.cleanup(); }
});


test('different cache names cannot collide with access and usage lock roles', { timeout: 30000 }, async () => {
  const f = fixture(); const a = f.request('first', { cache: { name: 'shared', maxGiB: 0.1 } }), b = f.request('second', { cache: { name: 'shared-access', maxGiB: 0.1 } });
  let first: ReturnType<typeof runProfile> | undefined, second: ReturnType<typeof runProfile> | undefined;
  try {
    first = runProfile(a); assert.equal(await f.started('first'), true);
    second = runProfile(b); assert.equal(await f.started('second'), true);
    f.release('first'); f.release('second');
    assert.equal((await first).receipt.outcome, 'passed'); assert.equal((await second).receipt.outcome, 'passed');
  } finally { a.interrupts?.trigger(); b.interrupts?.trigger(); await Promise.allSettled([first,second]); f.env.cleanup(); }
});


test('E2E kernel slots stay bounded while ordinary work overlaps and cancellation frees only its own budget', { timeout: 45000 }, async () => {
  const f = fixture();
  const machine = { ...f.machine, limits: { ...f.machine.limits, maxConcurrentJobs: 10, maxConcurrentE2eJobs: 1 } };
  const a = { ...f.request('browser-first', { workload: 'e2e' }), machine };
  const b = { ...f.request('browser-second', { workload: 'e2e' }), machine };
  const light = { ...f.request('typecheck', { workload: 'standard' }), machine };
  let browser: ReturnType<typeof runProfile> | undefined, background: ReturnType<typeof runProfile> | undefined, replacement: ReturnType<typeof runProfile> | undefined;
  try {
    const before = await fetchPreflight(f.transport, machine, [], []);
    browser = runProfile(a); assert.equal(await f.started('browser-first'), true);
    background = runProfile(light); assert.equal(await f.started('typecheck'), true);
    // Deliberately stale preflight simulates another controller's admission race.
    const refused = await runProfile({ ...b, preflightReport: before });
    assert.equal(refused.admission, 'refused');
    assert.equal(existsSync(join(f.env.root, 'started-browser-second')), false);
    const live = await fetchPreflight(f.transport, machine, [], []);
    assert.deepEqual(Object.values(live.sharedWorkloads ?? {}).sort(), ['e2e', 'standard']);
    a.interrupts?.trigger(); assert.equal((await browser).receipt.outcome, 'cancelled');
    assert.equal((await fetchPreflight(f.transport, machine, [], [])).sharedLocks?.length, 1);
    replacement = runProfile(b); assert.equal(await f.started('browser-second'), true);
    f.release('browser-second'); f.release('typecheck');
    assert.equal((await replacement).receipt.outcome, 'passed');
    assert.equal((await background).receipt.outcome, 'passed');
  } finally { a.interrupts?.trigger(); b.interrupts?.trigger(); light.interrupts?.trigger(); await Promise.allSettled([browser, background, replacement]); f.env.cleanup(); }
});

test('coordinator exposes and retains independent E2E capacity across restart', async () => {
  const f = fixture();
  const machine = { ...f.machine, limits: { ...f.machine.limits, maxConcurrentJobs: 10, maxConcurrentE2eJobs: 2 } };
  const dependencies: CoordinatorDependencies = { machines: () => [machine], inspect: async () => ({ machine, observedAt: new Date().toISOString(), report: report('physical') }), localFingerprint: async () => 'dispatcher', now: Date.now, route: () => ({ target: 'fixture', host: 'localhost', user: 'tester', port: 22, path: 'internet' }), execute: async () => { throw Error('unused'); } };
  const c = new Coordinator(f.env.paths, dependencies);
  type Lease = { token: string; reservation: { id: string } };
  try {
    const a = await c.reserve('one', 'e2e', ['mini'], 180, { mode: 'shared', resources: [], workload: 'e2e' }) as Lease;
    await c.reserve('two', 'e2e', ['mini'], 180, { mode: 'shared', resources: [], workload: 'e2e' });
    await assert.rejects(c.reserve('three', 'e2e', ['mini'], 180, { mode: 'shared', resources: [], workload: 'e2e' }));
    await c.reserve('light', 'check', ['mini'], 180, { mode: 'shared', resources: [], workload: 'standard' });
    const restarted = new Coordinator(f.env.paths, dependencies);
    const state = await restarted.state(true) as { workers: { capacity: { used: number; e2e: { limit: number; used: number } } }[] };
    assert.equal(state.workers[0]?.capacity.used, 3);
    assert.deepEqual(state.workers[0]?.capacity.e2e, { limit: 2, used: 2 });
    await assert.rejects(restarted.reserve('three', 'e2e', ['mini'], 180, { mode: 'shared', resources: [], workload: 'e2e' }));
    await restarted.release(a.reservation.id, a.token, true);
    await restarted.reserve('three', 'e2e', ['mini'], 180, { mode: 'shared', resources: [], workload: 'e2e' });
  } finally { f.env.cleanup(); }
});

test('workload classification recognizes browser commands and lets opaque wrappers declare their budget', () => {
  const make = (name: string, argv: string[], workload?: 'standard' | 'e2e') => ({ name, argv, ...(workload ? { workload } : {}) });
  for (const value of [make('browser', ['npx', 'playwright', 'test']), make('frontend-e2e', ['bash', 'script.sh']), make('test', ['bash', '-lc', 'npm run e2e'])]) {
    assert.equal(profileWorkload(value), 'e2e');
  }
  assert.equal(profileWorkload(make('check', ['npm', 'run', 'typecheck'])), 'standard');
  assert.equal(profileWorkload(make('e2e-config-unit', ['node', '--test'], 'standard')), 'standard');
  assert.equal(profileWorkload(make('checks', ['nx', 'run']), ['frontend-e2e:test']), 'e2e');
  assert.equal(parseClaim({ mode: 'shared', workload: 'e2e' }).workload, 'e2e');
  assert.throws(() => parseClaim({ mode: 'shared', workload: 'typo' }));
});
