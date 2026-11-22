// Real API selection boundaries with isolated state, controlled worker reports
// and injected execution/notification callbacks. No real SSH or native sender.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadMachines, registerProject, saveMachines } from '../src/registry.ts';
import type { Receipt } from '../src/run/receipt.ts';
import { AdmissionTransport } from './helpers/admissionTransport.ts';
import { testMachine, writeFiles, waitUntil } from './helpers/fixtures.ts';
import type { RunRequest, RunResult } from '../src/run/runJob.ts';
import { report, startServiceFixture, writeRun, type ServiceFixture } from './helpers/serviceFixture.ts';

async function fixture(outcome: Receipt['outcome'] = 'passed', execute?: (request: RunRequest) => Promise<RunResult>) {
  const attempted: string[] = [];
  const unavailable = new Set<string>();
  const preflights = new Map<string, Record<string, string>>();
  const f = await startServiceFixture({
    notifyDiskSpace: () => { throw new Error('A normal worker-selection test must not notify.'); },
    transportFor: (machine, home) => {
      attempted.push(machine.id);
      if (unavailable.has(machine.id)) throw new Error('Controlled unavailable worker');
      const transport = new AdmissionTransport(home);
      transport.fingerprint = machine.id;
      transport.diskFreeKiB = 64 * 1024 ** 2;
      Object.assign(transport.preflightValues, preflights.get(machine.id));
      return transport;
    },
    execute: execute ?? (async request => writeRun(request.paths.runsDir, request.jobId ?? 'fixture-job', {
      outcome, project: 'preference', profile: 'check', machine: request.machine.id,
    })),
  });
  try {
    for (const [id, target] of [['first', 'Mac-Mini'], ['second', 'OldMacBookPro']]) {
      const revision = (await f.call('GET', '/v1/config')).body['revision'];
      const added = await f.call('POST', '/v1/machines', { revision, id, target, makeDefault: id === 'second', limits: { ...testMachine().limits, maxConcurrentJobs: 3 } });
      assert.equal(added.status, 200, added.text);
      f.reports.set(target ?? '', report(id ?? 'worker'));
    }
    writeFiles(f.root, { a: 'input' });
    const manifest = { schemaVersion: 1, id: 'preference', sync: { include: ['a'] },
      profiles: { check: { description: 'selection fixture', kind: 'check', argv: ['true'], timeoutMinutes: 1 } } };
    const manifestPath = join(f.root, 'fleet.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    registerProject(f.paths, manifestPath, f.root, false);
    return { f, manifest, attempted, unavailable, preflights };
  } catch (error) { await f.close(); throw error; }
}

for (const route of ['submit', 'command', 'project'] as const) {
  test(`automatic ${route} chooses the CPU-busier worker with better memory headroom`, async () => {
    const { f, manifest, preflights } = await fixture();
    preflights.set('first', { load_average: '80 80 80', mem_available_bytes: String(6 * 1024 ** 3),
      swap_free_bytes: String(4 * 1024 ** 3), swap_disk_free_bytes: String(64 * 1024 ** 3) });
    try {
      const started = route === 'submit'
        ? await f.call('POST', '/v1/submit', { cwd: f.root, request: { source: f.root, manifest, profile: 'check' } })
        : route === 'command'
          ? await f.call('POST', '/v1/command', { cwd: f.root, argv: ['run', 'preference', 'check'] })
          : await f.call('POST', '/v1/projects/preference/run', { profile: 'check' });
      assert.equal((await finish(f, started.body['operationId']))['exitCode'], 0);
      assert.deepEqual(f.executed.map(r => r.machine.id), ['first']);
      assert.equal(f.executed[0]?.placement?.strategy, 'load-aware');
      assert.equal(f.executed[0]?.placement?.loadPerCpu, 8);
    } finally { await f.close(); }
  });
}

test('concurrent clients enforce the worker slot limit even when memory snapshots tie', async () => {
  const releases: (() => void)[] = [];
  const { f, manifest } = await fixture('passed', request => new Promise(resolve => {
    releases.push(() => resolve(writeRun(request.paths.runsDir, request.jobId ?? 'fixture-job', { machine: request.machine.id })));
  }));
  try {
    const start = () => f.call('POST', '/v1/submit', { cwd: f.root, request: { source: f.root, manifest, profile: 'check' } });
    const operations = [];
    for (let count = 1; count <= 4; count += 1) {
      operations.push(await start());
      assert.equal(await waitUntil(() => f.executed.length === count, 10_000), true);
    }
    assert.deepEqual(f.executed.map(r => r.machine.id), ['second', 'second', 'second', 'first']);
    releases.splice(0).forEach(release => release());
    for (const operation of operations) {
      assert.equal((await finish(f, operation.body['operationId']))['exitCode'], 0);
    }
  } finally { releases.splice(0).forEach(release => release()); await f.close(); }
});

test('automatic external reservations choose the CPU-busier worker with healthier memory and explicit lists stay binding', async () => {
  const { f } = await fixture();
  const GiB = 1024 ** 3;
  f.reports.set('Mac-Mini', report('first', { os: 'Darwin', memPressureLevel: 1, cpuCount: 10,
    loadAverage: [80], memAvailableBytes: 6 * GiB, swapFreeBytes: 4 * GiB, swapDiskFreeBytes: 64 * GiB }));
  f.reports.set('OldMacBookPro', report('second', { memPressureLevel: 1, cpuCount: 10, loadAverage: [1], memAvailableBytes: 8 * GiB }));
  try {
    const automatic = await f.call('POST', '/v1/reservations', { owner: 'auto-fixture', label: 'read-only route' });
    assert.equal(automatic.status, 200, automatic.text);
    const value = automatic.body['reservation'];
    assert.ok(value && typeof value === 'object' && 'machineId' in value && 'id' in value);
    assert.equal(value.machineId, 'first');
    assert.equal((await f.call('POST', '/v1/release', { id: value.id, token: automatic.body['token'] })).status, 200);
    const pinned = await f.call('POST', '/v1/reservations', { owner: 'pinned-fixture', label: 'explicit route', machines: ['second'] });
    assert.equal(pinned.status, 200, pinned.text);
    const lease = pinned.body['reservation'];
    assert.ok(lease && typeof lease === 'object' && 'machineId' in lease && 'id' in lease);
    assert.equal(lease.machineId, 'second');
    assert.equal((await f.call('POST', '/v1/release', { id: lease.id, token: pinned.body['token'] })).status, 200);
  } finally { await f.close(); }
});

async function finish(f: ServiceFixture, operationId: unknown) {
  assert.equal(typeof operationId, 'string');
  // Bound actual elapsed work, not the number of fast local socket replies:
  // a real preflight child may still be running after hundreds of replies.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await f.call('GET', `/v1/operations/${String(operationId)}`);
    assert.equal(response.status, 200, response.text);
    if (response.body['status'] === 'complete') return response.body;
  }
  throw new Error('Worker-selection operation did not finish.');
}

for (const route of ['submit', 'command', 'project'] as const) {
  test(`unpinned ${route} prefers the controller default even when registered second`, async () => {
    const { f, manifest, attempted } = await fixture();
    try {
      const started = route === 'submit'
        ? await f.call('POST', '/v1/submit', { cwd: f.root, request: { source: f.root, manifest, profile: 'check' } })
        : route === 'command'
          ? await f.call('POST', '/v1/command', { cwd: f.root, argv: ['run', 'preference', 'check'] })
          : await f.call('POST', '/v1/projects/preference/run', { profile: 'check' });
      assert.equal(started.status, 202, started.text);
      const end = await finish(f, started.body['operationId']);
      assert.equal(end['exitCode'], 0, JSON.stringify(end));
      assert.deepEqual(attempted, ['second', 'first']);
      assert.deepEqual(f.executed.map(request => request.machine.id), ['second']);
      assert.deepEqual(loadMachines(f.paths).machines.map(machine => machine.id), ['first', 'second']);
    } finally { await f.close(); }
  });
}

for (const machines of [['first'], ['first', 'second']]) {
  test(`explicit submit order ${machines.join(',')} overrides the controller default`, async () => {
    const { f, manifest, attempted } = await fixture();
    try {
      const started = await f.call('POST', '/v1/submit', { cwd: f.root, machines, request: { source: f.root, manifest, profile: 'check' } });
      const end = await finish(f, started.body['operationId']);
      assert.equal(end['exitCode'], 0, JSON.stringify(end));
      assert.deepEqual(attempted, ['first']);
      assert.deepEqual(f.executed.map(request => request.machine.id), ['first']);
    } finally { await f.close(); }
  });
}

test('an unpinned submit without a controller default keeps registration order', async () => {
  const { f, manifest, attempted } = await fixture();
  try {
    saveMachines(f.paths, { schemaVersion: 1, machines: loadMachines(f.paths).machines });
    const started = await f.call('POST', '/v1/submit', { cwd: f.root, request: { source: f.root, manifest, profile: 'check' } });
    assert.equal((await finish(f, started.body['operationId']))['exitCode'], 0);
    assert.deepEqual(attempted, ['first', 'second']);
  } finally { await f.close(); }
});

test('a one-time manifest worker pin overrides the controller default', async () => {
  const { f, manifest, attempted } = await fixture();
  try {
    const started = await f.call('POST', '/v1/submit', { cwd: f.root,
      request: { source: f.root, manifest: { ...manifest, defaultMachine: 'first' }, profile: 'check' } });
    assert.equal((await finish(f, started.body['operationId']))['exitCode'], 0);
    assert.deepEqual(attempted, ['first']);
  } finally { await f.close(); }
});

test('an unavailable preferred submit worker advances before any execution', async () => {
  const { f, manifest, attempted, unavailable } = await fixture();
  try {
    unavailable.add('second');
    const started = await f.call('POST', '/v1/submit', { cwd: f.root, request: { source: f.root, manifest, profile: 'check' } });
    assert.equal((await finish(f, started.body['operationId']))['exitCode'], 0);
    assert.deepEqual(attempted, ['second', 'first']);
    assert.deepEqual(f.executed.map(request => request.machine.id), ['first']);
  } finally { await f.close(); }
});

test('saved operation output retains each worker refusal after all candidates decline', async () => {
  const { f, manifest, unavailable, preflights } = await fixture();
  try {
    unavailable.add('first');
    preflights.set('second', { lock: 'busy' });
    const started = await f.call('POST', '/v1/submit', { cwd: f.root, machines: ['first', 'second'],
      request: { source: f.root, manifest, profile: 'check' } });
    const end = await finish(f, started.body['operationId']);
    assert.equal(end['exitCode'], 4, JSON.stringify(end));
    assert.match(String(end['output']), /first: Controlled unavailable worker/);
    assert.match(String(end['output']), /second: .*busy/i);
    assert.match(String(end['output']), /No available remote workers/);
    assert.equal(f.executed.length, 0);
    const saved = await f.call('GET', `/v1/operations/${started.body['operationId']}`);
    assert.equal(saved.body['output'], end['output']);
  } finally { await f.close(); }
});

test('an externally reserved preferred submit worker advances without execution', async () => {
  const { f, manifest, attempted } = await fixture();
  try {
    const held = await f.call('POST', '/v1/reservations', { owner: 'other-fixture', label: 'controlled busy', machines: ['second'] });
    assert.equal(held.status, 200, held.text);
    try {
      const started = await f.call('POST', '/v1/submit', { cwd: f.root, request: { source: f.root, manifest, profile: 'check' } });
      assert.equal((await finish(f, started.body['operationId']))['exitCode'], 0);
      assert.deepEqual(attempted, ['second', 'first']);
      assert.deepEqual(f.executed.map(request => request.machine.id), ['first']);
    } finally {
      const reservation = held.body['reservation'];
      assert.ok(reservation && typeof reservation === 'object' && 'id' in reservation);
      assert.equal((await f.call('POST', '/v1/release', { id: reservation.id, token: held.body['token'] })).status, 200);
    }
  } finally { await f.close(); }
});

test('a failed admitted submit on the preferred worker is never replayed', async () => {
  const { f, manifest, attempted } = await fixture('failed');
  try {
    const started = await f.call('POST', '/v1/submit', { cwd: f.root, request: { source: f.root, manifest, profile: 'check' } });
    assert.equal((await finish(f, started.body['operationId']))['exitCode'], 1);
    assert.deepEqual(attempted, ['second', 'first']);
    assert.deepEqual(f.executed.map(request => request.machine.id), ['second']);
  } finally { await f.close(); }
});
