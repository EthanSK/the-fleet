// Faults use fake senders and isolated workers: never show a false low-disk
// banner on the test host. Exercise each operation entry point and quiet case.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { test } from 'node:test';
import { registerProject } from '../src/registry.ts';
import { parseArchiveDiskSpaceProblem, reportDiskSpaceProblem, type DiskSpaceProblem } from '../src/run/diskSpace.ts';
import { runProfile } from '../src/run/runJob.ts';
import { operationDiskNotifier, sendAgentBridgeDiskNotification, type DiskSpaceNotification } from '../src/service/diskNotifications.ts';
import { inlineProject } from '../src/service/server.ts';
import { AdmissionTransport } from './helpers/admissionTransport.ts';
import { testEnvironment, testMachine, writeFiles } from './helpers/fixtures.ts';
import { report, startServiceFixture, writeRun, type ServiceFixture } from './helpers/serviceFixture.ts';

const disk: DiskSpaceProblem = { machineId: 'mini', phase: 'admission', message: 'Not enough free disk on mini: 1 GiB free, 8 GiB required' };
const archive: DiskSpaceProblem = { machineId: 'mini', phase: 'archive', message: 'The large scratch volume has insufficient free space.' };

test('one notification belongs to the operation, across workers and disk phases', () => {
  const sent: DiskSpaceNotification[] = [];
  const notify = operationDiskNotifier('operation-one', value => { sent.push(value); });
  notify(disk); notify({ ...disk, machineId: 'second' }); notify(archive);
  operationDiskNotifier('operation-two', value => { sent.push(value); })(archive);
  assert.deepEqual(sent.map(value => [value.operationId, value.phase]), [['operation-one', 'admission'], ['operation-two', 'archive']]);
});

test('failed notification delivery and throwing observers do not change or retry an operation', async () => {
  for (const asyncFailure of [false, true]) {
    let calls = 0;
    const warnings: unknown[] = [];
    const notify = operationDiskNotifier('operation', () => { calls += 1; if (asyncFailure) return Promise.reject(new Error('unavailable')); throw new Error('unavailable'); }, error => { warnings.push(error); });
    assert.doesNotThrow(() => { notify(disk); notify(archive); });
    await Promise.resolve();
    assert.equal(calls, 1); assert.equal(warnings.length, 1);
  }
  assert.doesNotThrow(() => reportDiskSpaceProblem(() => { throw new Error('observer'); }, disk));
  reportDiskSpaceProblem(async () => { throw new Error('async observer'); }, disk);
  await Promise.resolve();
});

test('the existing native sender targets the controller with literal argument values', async () => {
  const commands: { file: string; args: readonly string[] }[] = [];
  const message = 'Disk path with "quotes", $variables and `backticks`';
  await sendAgentBridgeDiskNotification({ ...disk, message, operationId: 'abc123' }, async (file, args) => { commands.push({ file, args }); });
  assert.deepEqual(commands, [{ file: 'agent-bridge', args: ['notify', '--local', '--title', 'The Fleet', '--message', message, '--subtitle', 'mini', '--group', 'the-fleet-disk-abc123'] }]);
});

test('only a typed archive-space payload becomes a disk event', () => {
  assert.deepEqual(parseArchiveDiskSpaceProblem(JSON.stringify({ phase: 'archive', message: archive.message }), 'mini'), archive);
  for (const input of ['busy', 'No space left on device', '{}', 'null', '[]', '{"phase":"transport","message":"disk"}', '{"phase":"archive","message":""}', '{"phase":"archive","message":"line\\nbreak"}']) {
    assert.equal(parseArchiveDiskSpaceProblem(input, 'mini'), undefined);
  }
});

test('a pinned run reports its actual disk refusal before starting a supervisor', async () => {
  const env = testEnvironment();
  const events: DiskSpaceProblem[] = [];
  try {
    const source = join(env.root, 'source'); writeFiles(source, { 'a': 'input' });
    const oneTime = inlineProject({ source, files: ['a'], command: ['true'], timeoutMinutes: 1, kind: 'check' }, env.root);
    const base = testMachine();
    await assert.rejects(runProfile({ ...oneTime, paths: env.paths, machine: { ...base, limits: { ...base.limits, minFreeDiskGiB: 8 } }, transport: env.transport,
      preflightReport: report('remote', { diskFreeBytes: 1 }), extraArgs: [], ignoreHeavyProcesses: false,
      io: { stdout: env.stdout, stderr: env.stderr, status: () => {}, onDiskSpaceProblem: event => { events.push(event); } } }), /Not enough free disk/);
    assert.equal(events.length, 1); assert.equal(events[0]?.phase, 'admission');
    assert.equal(env.transport.commands.length, 0);
  } finally { env.cleanup(); }
});

// These workers model disk faults; host compilers from neighbouring fleet jobs
// must not turn the synthetic worker into a heavy-process refusal.
async function addWorkers(f: ServiceFixture) {
  for (const [id, target] of [['mini', 'Mac-Mini'], ['second', 'OldMacBookPro']]) {
    const revision = (await f.call('GET', '/v1/config')).body['revision'];
    assert.equal((await f.call('POST', '/v1/machines', { revision, id, target, limits: { heavyProcessNames: [] } })).status, 200);
    f.reports.set(target ?? '', report(id ?? 'worker'));
  }
}

async function release(f: ServiceFixture, value: Record<string, unknown>) {
  const reservation = value['reservation']; assert.ok(reservation && typeof reservation === 'object' && 'id' in reservation);
  assert.equal((await f.call('POST', '/v1/release', { id: reservation.id, token: value['token'], workStopped: true })).status, 200);
}

test('state polls, normal reservations, memory problems and generic busy stay quiet', async () => {
  const sent: DiskSpaceNotification[] = [];
  const f = await startServiceFixture({ notifyDiskSpace: value => { sent.push(value); } });
  try {
    await addWorkers(f);
    f.reports.set('Mac-Mini', report('mini', { diskFreeBytes: 1 }));
    await f.call('GET', '/v1/state'); await f.call('GET', '/v1/state?fresh=1');
    assert.equal(sent.length, 0);
    f.reports.set('Mac-Mini', report('mini', { diskFreeBytes: 20 * 1024 ** 3 }));
    const good = await f.call('POST', '/v1/reservations', { owner: 'fixture', label: 'normal', machines: ['mini'] });
    assert.equal(good.status, 200); await release(f, good.body);
    for (const bad of [report('mini', { memAvailableBytes: 1 }), report('mini', { lock: { state: 'busy', jobId: 'other', label: 'other', orphaned: false } })]) {
      f.reports.set('Mac-Mini', bad);
      assert.equal((await f.call('POST', '/v1/reservations', { owner: 'fixture', label: 'not disk', machines: ['mini'] })).status, 409);
    }
    assert.equal(sent.length, 0);
  } finally { await f.close(); }
});

test('a reservation disk skip notifies once even when another worker succeeds', async () => {
  const sent: DiskSpaceNotification[] = [];
  const f = await startServiceFixture({ notifyDiskSpace: value => { sent.push(value); } });
  try {
    await addWorkers(f); f.reports.set('Mac-Mini', report('mini', { diskFreeBytes: 1 }));
    const result = await f.call('POST', '/v1/reservations', { owner: 'fixture', label: 'alternate', machines: ['mini', 'second'] });
    assert.equal(result.status, 200); assert.equal(sent.length, 1); assert.equal(sent[0]?.machineId, 'mini');
    await release(f, result.body);
  } finally { await f.close(); }
});

test('multiple low-disk workers produce one alert for one refused reservation', async () => {
  const sent: DiskSpaceNotification[] = [];
  const f = await startServiceFixture({ notifyDiskSpace: value => { sent.push(value); } });
  try {
    await addWorkers(f);
    for (const target of ['Mac-Mini', 'OldMacBookPro']) f.reports.set(target, report(target, { diskFreeBytes: 1 }));
    assert.equal((await f.call('POST', '/v1/reservations', { owner: 'fixture', label: 'full', machines: ['mini', 'second'] })).status, 409);
    assert.equal(sent.length, 1);
  } finally { await f.close(); }
});

async function finished(f: ServiceFixture, id: unknown) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const result = await f.call('GET', `/v1/operations/${String(id)}`);
    if (result.body['status'] === 'complete') return result.body;
    await wait(10);
  }
  throw new Error('Fixture operation did not finish.');
}

for (const route of ['submit', 'command', 'project'] as const) {
  test(`${route} shares one disk alert across an admission skip and archive refusal`, async () => {
    const sent: DiskSpaceNotification[] = [];
    const transports = new Map<string, AdmissionTransport>();
    const f = await startServiceFixture({
      notifyDiskSpace: value => { sent.push(value); },
      transportFor: (machine, home) => {
        let transport = transports.get(machine.id);
        if (!transport) { transport = new AdmissionTransport(home); transport.fingerprint = machine.id; transport.diskFreeKiB = machine.id === 'mini' ? 1 : 32 * 1024 ** 2; transports.set(machine.id, transport); }
        return transport;
      },
      execute: async request => {
        request.io.onDiskSpaceProblem?.({ ...archive, machineId: request.machine.id });
        return writeRun(request.paths.runsDir, request.jobId ?? 'fixture-job', { project: 'disk-fixture', profile: 'check', machine: request.machine.id });
      },
    });
    try {
      await addWorkers(f); writeFiles(f.root, { a: 'input' });
      const manifest = { schemaVersion: 1, id: 'disk-fixture', sync: { include: ['a'] }, profiles: { check: { description: 'disk fixture', kind: 'check', argv: ['true'], timeoutMinutes: 1 } } };
      const path = join(f.root, 'fleet.json'); writeFileSync(path, JSON.stringify(manifest)); registerProject(f.paths, path, f.root, false);
      const result = route === 'submit'
        ? await f.call('POST', '/v1/submit', { owner: 'fixture', cwd: f.root, detached: true, machines: ['mini', 'second'], request: { source: f.root, manifest, profile: 'check' } })
        : route === 'command'
          ? await f.call('POST', '/v1/command', { owner: 'fixture', cwd: f.root, detached: true, argv: ['run', 'disk-fixture', 'check', '--machines', 'mini,second'] })
          : await f.call('POST', '/v1/projects/disk-fixture/run', { owner: 'fixture', detached: true, profile: 'check', machines: ['mini', 'second'] });
      assert.equal(result.status, 202, result.text);
      const end = await finished(f, result.body['operationId']);
      assert.equal(end['exitCode'], 0, JSON.stringify(end));
      assert.equal(f.executed.length, 1); assert.equal(f.executed[0]?.machine.id, 'second');
      assert.equal(sent.length, 1); assert.equal(sent[0]?.machineId, 'mini'); assert.equal(sent[0]?.phase, 'admission');
    } finally { await f.close(); }
  });
}

test('a foreground stale capture propagates its typed disk problem without changing retained cleanup', async () => {
  const sent: DiskSpaceNotification[] = [];
  const f = await startServiceFixture({ notifyDiskSpace: value => { sent.push(value); },
    cleanupStale: async () => ({ result: 'artifact-capture-failed', detail: 'stale-job', diskSpaceProblem: archive }) });
  try {
    await addWorkers(f);
    f.reports.set('Mac-Mini', report('mini', { lock: { state: 'stale', jobId: 'stale-job', label: 'fixture' } }));
    const result = await f.call('POST', '/v1/maintenance', { machine: 'mini' });
    assert.equal(result.status, 200); assert.equal(sent.length, 1); assert.equal(sent[0]?.phase, 'archive');
    assert.match(result.text, /artifact-capture-failed/);
  } finally { await f.close(); }
});
