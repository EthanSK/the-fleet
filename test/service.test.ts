// Exercise cross-client ownership, crash recovery and the real local API.
// Remote execution is injected here; actual SSH is qualified separately.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Coordinator, type CoordinatorDependencies } from '../src/service/coordinator.ts';
import { callApi, ensureService } from '../src/service/client.ts';
import { inlineProject, startApi, serviceSocket } from '../src/service/server.ts';
import { resolveStatePaths } from '../src/paths.ts';
import { testMachine } from './helpers/fixtures.ts';
import type { PreflightReport } from '../src/run/preflight.ts';
import { LocalShellTransport } from './helpers/localShellTransport.ts';
import { CapturedStream } from './helpers/fixtures.ts';

function fixture() {
  const root = mkdtempSync('/tmp/the-fleet-test-');
  const paths = resolveStatePaths({ THE_FLEET_HOME: root });
  const machine = testMachine();
  let now = Date.now();
  let report: PreflightReport = { complete: true, fingerprint: 'remote', rootExists: true,
    guiSession: true, bsdtar: true, missingBaseTools: [], tools: new Map(), heavy: [], lock: { state: 'free' },
    cpuCount: 8, loadAverage: [1, 2, 3] };
  const dependencies: CoordinatorDependencies = {
    machines: () => [machine, { ...machine, id: 'alias' }],
    localFingerprint: async () => 'local', now: () => now,
    inspect: async (value) => ({ machine: value, report, observedAt: new Date(now).toISOString() }),
    route: () => ({ target: 'fixture', host: '100.64.0.1', user: 'tester', port: 22, path: 'internet' }),
    execute: async () => { throw new Error('not executed by reservation tests'); },
  };
  return { paths, dependencies, coordinator: new Coordinator(paths, dependencies),
    expire: () => { now += 400_000; }, busy: () => { report = { ...report, lock: { state: 'busy', jobId: 'another-job', label: 'busy', orphaned: false } }; },
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('concurrent apps and aliases cannot both reserve one physical machine', async () => {
  const f = fixture();
  try {
    const results = await Promise.allSettled([f.coordinator.reserve('app-one', 'tests', ['mini']), f.coordinator.reserve('app-two', 'build', ['alias'])]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    const state = JSON.stringify(await f.coordinator.state());
    assert.match(state, /app-one|app-two/); assert.match(state, /loadAverage/); assert.doesNotMatch(state, /tokenHash/);
  } finally { f.cleanup(); }
});

test('expired and restarted external reservations keep ownership until verified release', async () => {
  const f = fixture();
  try {
    const result = await f.coordinator.reserve('owner', 'external tests', ['mini']) as { reservation: { id: string }; token: string };
    f.expire();
    await assert.rejects(f.coordinator.reserve('second', 'build', ['mini']), /No available/);
    const restarted = new Coordinator(f.paths, f.dependencies);
    assert.match(JSON.stringify(await restarted.state()), /unverified/);
    await assert.rejects(restarted.release(result.reservation.id, 'wrong-token'), /token/);
    await restarted.release(result.reservation.id, result.token);
    assert.doesNotMatch(readFileSync(join(f.paths.home, 'reservations.json'), 'utf8'), /owner/);
  } finally { f.cleanup(); }
});

test('busy remote refuses release and route errors never strand reservations', async () => {
  const f = fixture();
  try {
    const broken = new Coordinator(f.paths, { ...f.dependencies, route: () => { throw new Error('broken route'); } });
    await assert.rejects(broken.reserve('owner', 'tests', ['mini']), /broken route/);
    assert.deepEqual((await broken.state() as { reservations: unknown[] }).reservations, []);
    const result = await f.coordinator.reserve('owner', 'tests', ['mini']) as { reservation: { id: string }; token: string };
    f.busy(); await assert.rejects(f.coordinator.release(result.reservation.id, result.token), /busy/);
  } finally { f.cleanup(); }
});

test('one-time request validates a real profile without registering it', () => {
  const input = { source: '.', files: ['src/**'], command: ['node', '--test'], timeoutMinutes: 2, success: { minTestCount: { pattern: 'tests (\\d+)', min: 1 } } };
  const result = inlineProject(input, '/tmp');
  assert.equal(result.sourceRoot, '/tmp'); assert.equal(result.project.manifest.id, 'ad-hoc');
  assert.throws(() => inlineProject({ ...input, command: [] }, '/tmp'));
});

test('API validates input, exposes state, and shares reservation ownership', async () => {
  const f = fixture(); const api = startApi(f.paths, f.coordinator);
  await new Promise<void>((done) => api.server.listen(serviceSocket(f.paths), done));
  try {
    assert.equal((await callApi(f.paths, 'GET', '/v1/health'))['application'], 'The Fleet');
    const reservation = await callApi(f.paths, 'POST', '/v1/reservations', { owner: 'api-app', label: 'tests', machines: ['mini'] });
    await assert.rejects(callApi(f.paths, 'POST', '/v1/reservations', { owner: 'other-app', label: 'tests', machines: ['alias'] }), /No available/);
    await assert.rejects(callApi(f.paths, 'POST', '/v1/reservations', { owner: '', label: 'tests' }), /Invalid/);
    await callApi(f.paths, 'POST', '/v1/release', { id: (reservation['reservation'] as { id: string }).id, token: reservation['token'] });
  } finally { await api.shutdown(); f.cleanup(); }
});

test('many simultaneous CLI auto-starts use one kernel-locked coordinator', { timeout: 30_000 }, async () => {
  const f = fixture();
  try {
    await Promise.all(Array.from({ length: 6 }, () => ensureService(f.paths)));
    const observations = await Promise.all(Array.from({ length: 6 }, () => callApi(f.paths, 'GET', '/v1/health')));
    assert.equal(new Set(observations.map((value) => value['pid'])).size, 1);
    await callApi(f.paths, 'POST', '/v1/stop', {});
    await new Promise((done) => setTimeout(done, 500));
    await ensureService(f.paths);
    assert.notEqual((await callApi(f.paths, 'GET', '/v1/health'))['pid'], observations[0]?.['pid']);
  } finally {
    await callApi(f.paths, 'POST', '/v1/stop', {}).catch(() => {});
    await new Promise((done) => setTimeout(done, 300)); f.cleanup();
  }
});

test('invalid persisted ownership fails closed', () => {
  const f = fixture();
  try { writeFileSync(join(f.paths.home, 'reservations.json'), '[{"id":"x","fingerprint":"remote","tokenHash":"x"}]'); assert.throws(() => new Coordinator(f.paths, f.dependencies), /Invalid reservation/); }
  finally { f.cleanup(); }
});

test('managed execution reserves the worker and releases a verified pre-admission failure', async () => {
  const f = fixture(); let fail: (() => void) | undefined;
  const coordinator = new Coordinator(f.paths, { ...f.dependencies, execute: async () => {
    await new Promise<void>((done) => { fail = done; }); throw new Error('validation failed');
  } });
  try {
    const project = inlineProject({ source: '.', files: ['test.ts'], command: ['node', '--test'], timeoutMinutes: 1,
      success: { minTestCount: { pattern: 'tests (\\d+)', min: 1 } } }, '/tmp');
    const running = coordinator.runOne('managed-app', 'a'.repeat(24), { ...project, paths: f.paths, machine: testMachine(),
      transport: new LocalShellTransport('/tmp'), extraArgs: [], ignoreHeavyProcesses: false,
      io: { stdout: new CapturedStream(), stderr: new CapturedStream(), status: () => {} } });
    const failure = assert.rejects(running, /validation failed/);
    await new Promise((done) => setTimeout(done, 5));
    await assert.rejects(coordinator.reserve('other', 'external', ['mini']), /No available/);
    assert.ok(fail); fail(); await failure;
    const next = await coordinator.reserve('other', 'external', ['mini']); assert.ok(next);
  } finally { f.cleanup(); }
});

test('restart recovery clears managed ownership only after a conclusive idle probe', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.paths.home, 'reservations.json'), JSON.stringify([{ id: 'a'.repeat(24), machineId: 'mini', fingerprint: 'remote',
      owner: 'managed-app', label: 'tests', kind: 'managed', createdAt: new Date().toISOString(), expiresAt: null,
      tokenHash: 'a'.repeat(64), state: 'active' }]));
    const restarted = new Coordinator(f.paths, f.dependencies);
    assert.deepEqual(await restarted.recoverManaged(), ['a'.repeat(24)]);
    assert.ok(await restarted.reserve('new-app', 'tests', ['mini']));
  } finally { f.cleanup(); }
});
