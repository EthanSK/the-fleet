// Reservation-owned loopback forwards: ownership, readiness, collisions,
// reconnection, release and service shutdown. The ssh session is replaced by a
// local Node listener that holds the requested ports; the route is never used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import { Coordinator, type CoordinatorDependencies } from '../src/service/coordinator.ts';
import { callApi } from '../src/service/client.ts';
import { startApi, serviceSocket } from '../src/service/server.ts';
import { parseForwards } from '../src/service/forwarding.ts';
import { resolveStatePaths } from '../src/paths.ts';
import { FORWARDING_READY, forwardingArguments } from '../src/transport/sshTransport.ts';
import { wrapChild, type PortForward, type RemoteProcess } from '../src/transport/transport.ts';
import type { PreflightReport } from '../src/run/preflight.ts';
import { testMachine } from './helpers/fixtures.ts';

const LISTENER = `
const net = require('node:net');
const ports = JSON.parse(process.argv[1]);
let pending = ports.length;
for (const port of ports) net.createServer().listen(port, '127.0.0.1', () => {
  if (--pending === 0) console.log(${JSON.stringify(FORWARDING_READY)});
});
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No port');
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function until(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await condition()) return true;
    await new Promise((done) => setTimeout(done, 50));
  }
  return false;
}

async function fixture(options: { listener?: (forwards: readonly PortForward[]) => RemoteProcess } = {}) {
  const root = mkdtempSync('/tmp/the-fleet-forwarding-');
  const paths = resolveStatePaths({ THE_FLEET_HOME: root });
  const base = testMachine();
  const machine = { ...base, env: { DOCKER_CONTEXT: 'fixture-docker', PRIVATE_VALUE: 'fixture-secret' }, limits: { ...base.limits, maxConcurrentJobs: 2 } };
  const report: PreflightReport = { complete: true, fingerprint: 'remote', rootExists: true, guiSession: true, bsdtar: true, missingBaseTools: [], tools: new Map(), heavy: [], lock: { state: 'free' }, cpuCount: 8, loadAverage: [1, 1, 1] };
  const sessions: RemoteProcess[] = [];
  const dependencies: CoordinatorDependencies = {
    machines: () => [machine],
    localFingerprint: async () => 'local', now: Date.now,
    inspect: async (value) => ({ machine: value, report, observedAt: new Date().toISOString() }),
    route: () => ({ target: 'fixture', host: '100.64.0.1', user: 'tester', port: 22, path: 'internet' }),
    execute: async () => { throw new Error('not executed by forwarding tests'); },
    forward: (_machine, forwards) => {
      const session = options.listener?.(forwards) ?? wrapChild(spawn(process.execPath, ['-e', LISTENER, JSON.stringify(forwards.map((forward) => forward.localPort))], { stdio: ['pipe', 'pipe', 'pipe'] }));
      sessions.push(session);
      return session;
    },
    forwardingOptions: { readyTimeoutMs: 5_000, retryDelayMs: 50 },
  };
  const coordinator = new Coordinator(paths, dependencies);
  const api = startApi(paths, coordinator);
  await new Promise<void>((done) => api.server.listen(serviceSocket(paths), done));
  const reservationFor = async (id: string) => {
    const state = await coordinator.state() as { reservations: { id: string; forwarding?: { state: string; forwards: PortForward[]; attempts: number; detail?: string } }[] };
    return state.reservations.find((lease) => lease.id === id);
  };
  return {
    paths, coordinator, api, sessions, machine, reservationFor,
    reserve: async (owner: string, resources: string[]) => await callApi(paths, 'POST', '/v1/reservations', { owner, label: 'manual stack', machines: ['mini'], claim: { mode: 'shared', resources } }) as { reservation: { id: string }; token: string; connection: Record<string, unknown> },
    cleanup: async () => { await api.shutdown(); for (const session of sessions) session.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }); },
  };
}

test('forwarding arguments bind loopback on both ends, skip compression and exit on a failed forward', () => {
  const args = forwardingArguments({ target: 'Mini', host: '100.64.0.5', user: 'ethan', port: 22, path: 'internet' }, [{ localPort: 3021, remotePort: 3021 }, { localPort: 18101, remotePort: 18101 }]);
  assert.ok(args.includes('-N'));
  assert.ok(args.includes('ExitOnForwardFailure=yes'));
  assert.ok(!args.includes('-C'));
  assert.deepEqual(args.filter((argument) => argument.includes('127.0.0.1')), ['127.0.0.1:3021:127.0.0.1:3021', '127.0.0.1:18101:127.0.0.1:18101']);
  assert.deepEqual(args.slice(-1), ['ethan@100.64.0.5']);
});

test('forward requests need unique unprivileged local ports and valid remote ports', () => {
  assert.deepEqual(parseForwards([{ localPort: 3021, remotePort: 3021 }]), [{ localPort: 3021, remotePort: 3021 }]);
  assert.throws(() => parseForwards([]), /must not be empty/);
  assert.throws(() => parseForwards([{ localPort: 80, remotePort: 80 }]), /at least 1024/);
  assert.throws(() => parseForwards([{ localPort: 3021, remotePort: 3021 }, { localPort: 3021, remotePort: 4000 }]), /listed twice/);
  assert.throws(() => parseForwards([{ localPort: 3021, remotePort: 70000 }]), /at most 65535/);
  assert.throws(() => parseForwards([{ localPort: 3021 }]), /must be a number/);
  assert.throws(() => parseForwards([{ localPort: 3021, remotePort: 3021, host: 'x' }]), /unknown field/);
});

test('an external reservation owns loopback forwards that are visible, collision-checked, stoppable and ended by release', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.reserve('app-one', ['port:3021']);
    assert.equal(typeof first.connection['remoteRoot'], 'string', 'the connection carries the registered remote folder');
    assert.deepEqual(first.connection['pathPrepend'], f.machine.pathPrepend);
    assert.equal(first.connection['dockerContext'], 'fixture-docker');
    assert.doesNotMatch(JSON.stringify(first.connection), /PRIVATE_VALUE|fixture-secret/);
    const port = await freePort();
    const reply = await callApi(f.paths, 'POST', '/v1/forwards', { id: first.reservation.id, token: first.token, forwards: [{ localPort: port, remotePort: 3021 }] }) as { forwarding: { state: string; attempts: number } };
    assert.equal(reply.forwarding.state, 'connected');
    assert.equal(reply.forwarding.attempts, 1);
    assert.equal(await accepts(port), true);
    const shown = await f.reservationFor(first.reservation.id);
    assert.equal(shown?.forwarding?.state, 'connected');
    assert.deepEqual(shown?.forwarding?.forwards, [{ localPort: port, remotePort: 3021 }]);
    assert.doesNotMatch(JSON.stringify(shown), /100\.64\.0\.1|tester/, 'state never shows the route');
    await assert.rejects(callApi(f.paths, 'POST', '/v1/forwards', { id: first.reservation.id, token: 'wrong', forwards: [{ localPort: port, remotePort: 3021 }] }), /token/);

    const second = await f.reserve('app-two', ['port:3022']);
    await assert.rejects(callApi(f.paths, 'POST', '/v1/forwards', { id: second.reservation.id, token: second.token, forwards: [{ localPort: port, remotePort: 3022 }] }), new RegExp(`already forwarded by reservation ${first.reservation.id} \\(app-one`));
    assert.equal((await f.reservationFor(second.reservation.id))?.forwarding, undefined, 'a refused request leaves nothing behind');

    await callApi(f.paths, 'POST', '/v1/forwards/stop', { id: first.reservation.id, token: first.token });
    assert.equal((await f.reservationFor(first.reservation.id))?.forwarding, undefined);
    assert.equal(await until(async () => !(await accepts(port))), true, 'stopping waits for the session to exit');

    const again = await callApi(f.paths, 'POST', '/v1/forwards', { id: first.reservation.id, token: first.token, forwards: [{ localPort: port, remotePort: 3021 }] }) as { forwarding: { state: string } };
    assert.equal(again.forwarding.state, 'connected');
    await callApi(f.paths, 'POST', '/v1/release', { id: first.reservation.id, token: first.token, workStopped: true });
    assert.equal(await accepts(port), false, 'release ends the forwards before dropping ownership');
    await callApi(f.paths, 'POST', '/v1/release', { id: second.reservation.id, token: second.token, workStopped: true });
  } finally { await f.cleanup(); }
});

test('a dropped session reconnects with backoff and a never-ready session fails without retrying', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const lease = await f.reserve('app', ['port:3021']);
    const port = await freePort();
    await callApi(f.paths, 'POST', '/v1/forwards', { id: lease.reservation.id, token: lease.token, forwards: [{ localPort: port, remotePort: 3021 }] });
    f.sessions[0]?.kill('SIGKILL');
    assert.equal(await until(async () => (await f.reservationFor(lease.reservation.id))?.forwarding?.state === 'connected' && f.sessions.length === 2), true, 'the session is replaced after it drops');
    assert.equal((await f.reservationFor(lease.reservation.id))?.forwarding?.attempts, 2);
    assert.equal(await accepts(port), true);
    await callApi(f.paths, 'POST', '/v1/forwards/stop', { id: lease.reservation.id, token: lease.token });

    // ssh's bind failure: the session ends at once with its reason, nothing listens.
    const broken = await fixture({ listener: () => wrapChild(spawn('/bin/sh', ['-c', `echo 'bind [127.0.0.1]:${port}: Address already in use' >&2; exit 255`], { stdio: ['pipe', 'pipe', 'pipe'] })) });
    try {
      const other = await broken.reserve('app', ['port:3021']);
      await assert.rejects(callApi(broken.paths, 'POST', '/v1/forwards', { id: other.reservation.id, token: other.token, forwards: [{ localPort: port, remotePort: 3021 }] }), /did not become ready.*local port is already in use/);
      assert.equal((await broken.reservationFor(other.reservation.id))?.forwarding, undefined, 'a failed first session is not retried in the background');
      assert.equal(broken.sessions.length, 1);
    } finally { await broken.cleanup(); }
  } finally { await f.cleanup(); }
});

test('service shutdown ends every owned forward', { timeout: 30_000 }, async () => {
  const f = await fixture();
  const lease = await f.reserve('app', ['port:3021']);
  const port = await freePort();
  try {
    await callApi(f.paths, 'POST', '/v1/forwards', { id: lease.reservation.id, token: lease.token, forwards: [{ localPort: port, remotePort: 3021 }] });
    assert.equal(await accepts(port), true);
  } finally { await f.cleanup(); }
  assert.equal(await until(async () => !(await accepts(port))), true);
});
