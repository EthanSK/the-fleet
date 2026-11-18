// Exercise cross-client ownership, crash recovery and the real local API.
// Remote execution is injected here; actual SSH is qualified separately.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Coordinator, type CoordinatorDependencies } from '../src/service/coordinator.ts';
import { callApi, ensureService } from '../src/service/client.ts';
import { inlineProject, startApi, serviceSocket } from '../src/service/server.ts';
import { resolveStatePaths } from '../src/paths.ts';
import { testMachine } from './helpers/fixtures.ts';
import type { PreflightReport } from '../src/run/preflight.ts';
import { LocalShellTransport } from './helpers/localShellTransport.ts';
import { CapturedStream } from './helpers/fixtures.ts';

function fixture(maxConcurrentJobs = 1) {
  const root = mkdtempSync('/tmp/the-fleet-test-');
  const paths = resolveStatePaths({ THE_FLEET_HOME: root });
  const baseMachine = testMachine();
  const machine = { ...baseMachine, limits: { ...baseMachine.limits, maxConcurrentJobs } };
  let now = Date.now();
  let report: PreflightReport = { complete: true, fingerprint: 'remote', rootExists: true,
    guiSession: true, bsdtar: true, missingBaseTools: [], tools: new Map(), heavy: [], lock: { state: 'free' }, admissionFree: true,
    cpuCount: 8, loadAverage: [1, 2, 3] };
  const dependencies: CoordinatorDependencies = {
    machines: () => [machine, { ...machine, id: 'alias' }],
    localFingerprint: async () => 'local', now: () => now,
    inspect: async (value) => ({ machine: value, report, observedAt: new Date(now).toISOString() }),
    route: () => ({ target: 'fixture', host: '100.64.0.1', user: 'tester', port: 22, path: 'internet' }),
    execute: async () => { throw new Error('not executed by reservation tests'); },
  };
  return { paths, dependencies, coordinator: new Coordinator(paths, dependencies),
    pending: () => { report = { ...report, pendingArtifacts: machine.limits.keepJobs }; },
    expire: () => { now += 400_000; }, busy: () => { report = { ...report, lock: { state: 'busy', jobId: 'another-job', label: 'busy', orphaned: false } }; },
    idle: () => { report = { ...report, lock: { state: 'free' } }; },
    stale: () => { report = { ...report, sharedLocks: [{ state: 'stale', jobId: 'old-report', label: 'Preserved output' }] }; },
    setRemoteIdentity: (fingerprint: string) => { report = { ...report, fingerprint }; },
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('pending results block managed availability without blocking direct SSH reservations', async () => {
  const f = fixture();
  f.pending();
  try {
    const state = await f.coordinator.state(true) as { workers: { available: boolean; reasons: string[] }[] };
    assert.equal(state.workers[0]?.available, false);
    assert.match(state.workers[0]?.reasons.join(' ') ?? '', /recover pending artifacts/);
    const lease = await f.coordinator.reserve('owner', 'external SSH', ['mini']) as { reservation: { id: string }; token: string };
    await f.coordinator.release(lease.reservation.id, lease.token);
  } finally { f.cleanup(); }
});

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

test('a client that disconnects during worker inspection leaves no reservation', { timeout: 5000 }, async () => {
  function signal() {
    let resolve = () => {};
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  }
  const f = fixture();
  const inspectionStarted = signal();
  const finishInspection = signal();
  const responseClosed = signal();
  const admissionFinished = signal();
  const coordinator = new Coordinator(f.paths, {
    ...f.dependencies,
    inspect: async (machine) => {
      inspectionStarted.resolve();
      await finishInspection.promise;
      return f.dependencies.inspect(machine);
    },
  });
  const reserve = coordinator.reserve.bind(coordinator);
  coordinator.reserve = async (...args) => {
    try {
      return await reserve(...args);
    } finally {
      admissionFinished.resolve();
    }
  };

  const api = startApi(f.paths, coordinator);
  await new Promise<void>((done) => api.server.listen(serviceSocket(f.paths), done));
  api.server.once('request', (_request, response) => response.once('close', responseClosed.resolve));
  const client = request({ socketPath: serviceSocket(f.paths), method: 'POST', path: '/v1/reservations' });
  client.on('error', () => {});
  client.end(JSON.stringify({ owner: 'abandoned-client', label: 'desktop tests', machines: ['mini'] }));
  try {
    await inspectionStarted.promise;
    client.destroy();
    await responseClosed.promise;
    finishInspection.resolve();
    await admissionFinished.promise;

    assert.deepEqual((await callApi(f.paths, 'GET', '/v1/state'))['reservations'], []);
    const next = await callApi(f.paths, 'POST', '/v1/reservations', { owner: 'next-client', label: 'desktop tests', machines: ['mini'] });
    const lease = next as { reservation: { id: string }; token: string };
    await coordinator.release(lease.reservation.id, lease.token);
  } finally {
    client.destroy();
    finishInspection.resolve();
    await api.shutdown();
    f.cleanup();
  }
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

test('offline recovery checks exact expired ownership and preserves other desktop capacity and credentials', async () => {
  const f = fixture(3);
  try {
    const claim = { mode: 'shared', resources: ['desktop'], workload: 'e2e' } as const;
    const match = { owner: 'original-owner', machineId: 'mini', fingerprint: 'remote' };
    const lease = await f.coordinator.reserve(match.owner, 'GUI tests', ['mini'], 180, claim) as { reservation: { id: string }; token: string };
    const neighbor = await f.coordinator.reserve('neighbor', 'ordinary tests', ['mini'], 180, { mode: 'shared', resources: [] }) as { reservation: { id: string }; token: string };
    const target = { ...match, id: lease.reservation.id };
    const readStore = () => readFileSync(join(f.paths.home, 'reservations.json'), 'utf8');
    const originalStore = readStore();
    const offline = new Coordinator(f.paths, f.dependencies, 'offline-recovery');
    await assert.rejects(offline.recoverExpiredExternal(target), /has not expired/);
    f.expire();
    await assert.rejects(f.coordinator.reserve('second', 'GUI tests', ['mini'], 180, claim), /No available/);
    await assert.rejects(offline.recoverExpiredExternal({ ...target, owner: 'different-owner' }), /No external reservation/);
    f.setRemoteIdentity('different-ship');
    await assert.rejects(offline.recoverExpiredExternal(target), /identity/);
    f.setRemoteIdentity('remote');
    f.busy();
    await assert.rejects(offline.recoverExpiredExternal(target), /busy/);
    assert.equal(readStore(), originalStore);
    f.idle();
    const released = await offline.recoverExpiredExternal(target);
    assert.equal(released.id, lease.reservation.id);
    assert.equal(released.state, 'expired');
    assert.equal('tokenHash' in released, false);
    const originalRecords = JSON.parse(originalStore) as { id: string }[];
    assert.deepEqual(JSON.parse(readStore()), originalRecords.filter(record => record.id === neighbor.reservation.id));
    const restarted = new Coordinator(f.paths, f.dependencies);
    const next = await restarted.reserve('second', 'GUI tests', ['mini'], 180, claim) as { reservation: { id: string }; token: string };
    await restarted.release(neighbor.reservation.id, neighbor.token, true);
    await restarted.release(next.reservation.id, next.token, true);
  } finally { f.cleanup(); }
});

test('recovery CLI uses the running coordinator or explicitly waits for graceful stop', { timeout: 20_000 }, async () => {
  const f = fixture();
  await ensureService(f.paths);
  try {
    const cli = fileURLToPath(new URL('../bin/the-fleet.js', import.meta.url));
    const recover = (flags: string[], waiting = () => {}) => new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'recover-external-reservation', '--id', 'claim', '--owner', 'owner', '--machine', 'mini',
        '--fingerprint', 'remote', '--work-stopped', ...flags], { env: { ...process.env, THE_FLEET_HOME: f.paths.home }, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        const alreadyWaiting = stderr.includes('Waiting for the coordinator lock.');
        stderr += chunk.toString();
        if (!alreadyWaiting && stderr.includes('Waiting for the coordinator lock.')) waiting();
      });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stderr }));
    });
    const result = await recover([]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /No external reservation matches/);
    assert.equal((await callApi(f.paths, 'GET', '/v1/health'))['application'], 'The Fleet');
    let signalWaiting = () => {};
    const ready = new Promise<void>((resolve) => { signalWaiting = resolve; });
    const queued = recover(['--wait-for-stop'], signalWaiting);
    await Promise.race([ready, queued.then(() => assert.fail('Recovery returned before waiting for the lock'))]);
    assert.equal((await callApi(f.paths, 'POST', '/v1/stop', {}))['stopping'], true);
    const completed = await queued;
    assert.equal(completed.code, 2);
    assert.match(completed.stderr, /No external reservation matches/);
  } finally { await callApi(f.paths, 'POST', '/v1/stop', {}).catch(() => {}); f.cleanup(); }
});

test('live recovery frees exactly the expired desktop and preserves a stale report and neighboring claim', async () => {
  const f = fixture(3);
  const api = startApi(f.paths, f.coordinator);
  await new Promise<void>(done => api.server.listen(serviceSocket(f.paths), done));
  try {
    const claim = { mode: 'shared', resources: ['desktop'], workload: 'e2e' };
    const { reservation } = await callApi(f.paths, 'POST', '/v1/reservations', {
      owner: 'original', label: 'desktop tests', machines: ['mini'], claim,
    });
    const { reservation: neighbor } = await callApi(f.paths, 'POST', '/v1/reservations', {
      owner: 'other', label: 'ordinary work', machines: ['mini'], claim: { mode: 'shared', resources: [] },
    });
    const { id } = reservation as { id: string };
    const target = { id, owner: 'original', machineId: 'mini', fingerprint: 'remote' };
    const recover = (overrides: Record<string, unknown> = {}) =>
      callApi(f.paths, 'POST', '/v1/reservations/recover', { ...target, workStopped: true, ...overrides });

    await assert.rejects(recover({ workStopped: false }), /work has stopped/);
    await assert.rejects(recover(), /has not expired/);
    f.expire();
    await assert.rejects(recover({ owner: 'other' }), /No external reservation matches/);
    f.busy();
    await assert.rejects(recover(), /ship is busy/);
    f.idle();
    f.stale();
    const result = await recover();
    assert.equal((result['released'] as { id: string }).id, id);
    const { reservations, workers } = await f.coordinator.state(true) as {
      reservations: { id: string }[];
      workers: { health: { sharedLocks: { jobId: string }[] } }[];
    };
    assert.deepEqual(reservations.map(lease => lease.id), [(neighbor as { id: string }).id]);
    assert.equal(workers[0]?.health.sharedLocks[0]?.jobId, 'old-report');
    const next = await callApi(f.paths, 'POST', '/v1/reservations', {
      owner: 'next', label: 'desktop tests', machines: ['mini'], claim,
    });
    await callApi(f.paths, 'POST', '/v1/release', {
      id: (next['reservation'] as { id: string }).id, token: next['token'], workStopped: true,
    });
  } finally {
    await api.shutdown();
    f.cleanup();
  }
});

test('recovery refuses a claim renewed while the ship check was running', async () => {
  const f = fixture();
  try {
    const claim = await f.coordinator.reserve('owner', 'desktop tests', ['mini']) as { reservation: { id: string }; token: string };
    f.expire();
    let finishInspection!: () => void;
    const inspectionGate = new Promise<void>(resolve => { finishInspection = resolve; });
    const coordinator = new Coordinator(f.paths, {
      ...f.dependencies,
      inspect: async machine => {
        await inspectionGate;
        return f.dependencies.inspect(machine);
      },
    });
    const id = claim.reservation.id;
    const recovering = coordinator.recoverExpiredExternal({ id, owner: 'owner', machineId: 'mini', fingerprint: 'remote' });
    coordinator.renew(id, claim.token);
    finishInspection();
    await assert.rejects(recovering, /reservation changed/);
    assert.equal(coordinator.reservationById(id)?.state, 'active');
  } finally {
    f.cleanup();
  }
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
