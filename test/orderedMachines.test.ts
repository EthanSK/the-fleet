// Worker selection uses controlled remote homes. These tests prove one-pass
// admission behavior without pretending the unavailable second Mac is qualified.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadProject, registerProject } from '../src/registry.ts';
import { compareWorkerLoad, defaultMachineNames, orderedMachines, runOnOrderedMachines } from '../src/run/orderedMachines.ts';
import { report } from './helpers/serviceFixture.ts';
import { fetchPreflight } from '../src/run/remoteChecks.ts';
import { Interrupts } from '../src/run/runJob.ts';
import { evaluatePreflight, parsePreflight } from '../src/run/preflight.ts';
import type { Machine } from '../src/schema/machines.ts';
import { AdmissionTransport } from './helpers/admissionTransport.ts';
import { testEnvironment, testMachine, writeFiles } from './helpers/fixtures.ts';


function setup(command = 'echo tests 1', requires: Record<string, unknown> = {}, profile: Record<string, unknown> = {}) {
  const first = testEnvironment();
  const second = testEnvironment();
  const source = join(first.root, 'source');
  writeFiles(source, { 'run.sh': command });
  const manifest = join(first.root, 'project.json');
  writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, id: 'workers', sourceRoot: source, sync: { include: ['run.sh'] },
    profiles: { test: { description: 'workers', kind: 'test', argv: ['bash', 'run.sh'], requires,
      timeoutMinutes: 0.1, success: { minTestCount: { pattern: 'tests (\\d+)', min: 1 } }, ...profile } } }));
  registerProject(first.paths, manifest, undefined, false);
  const machines: [Machine, Machine] = [testMachine({ id: 'first', aliases: [] }), testMachine({ id: 'second', aliases: [] })];
  const transports: [AdmissionTransport, AdmissionTransport] = [new AdmissionTransport(first.remoteHome), new AdmissionTransport(second.remoteHome)];
  const request = { paths: first.paths, project: loadProject(first.paths, 'workers'), profileName: 'test',
    sourceRoot: source, extraArgs: [], ignoreHeavyProcesses: false, machines, dispatcherFingerprint: 'controlled-dispatcher',
    transportFor: (machine: { id: string }) => {
      const transport = transports[machine.id === 'first' ? 0 : 1];
      assert.ok(transport);
      return transport;
    }, io: { stdout: first.stdout, stderr: first.stderr, status: (_line: string) => {} } };
  return { request, machines, transports, environments: [first, second] as const, cleanup: () => { first.cleanup(); second.cleanup(); } };
}

test('pending result counts parse separately from slots and use the existing ship cap', () => {
  const machine = testMachine({ limits: { ...testMachine().limits, keepJobs: 2 } });
  for (const [text, expected] of [['0', 0], ['2', 2], ['3', 3], ['-1', undefined], ['0.5', undefined], ['bad', undefined]] as const) {
    const parsed = parsePreflight(`pending_artifacts=${text}\nlock=free\ndone=1\n`);
    assert.equal(parsed.pendingArtifacts, expected);
    const decision = evaluatePreflight(parsed, machine, undefined, { ignoreHeavyProcesses: false, nowEpoch: 0 });
    assert.equal(decision.refusals.some(finding => finding.kind === 'busy'), expected !== undefined && expected >= 2);
  }
  assert.equal(parsePreflight('lock=free\ndone=1\n').pendingArtifacts, undefined, 'older observations remain compatible; worker still checks at admission');
});

for (const pinned of [false, true]) {
  test(`a full pending-results ship ${pinned ? 'stays refused when pinned' : 'is skipped before unpinned admission'}`, { timeout: 30000 }, async () => {
    const f = setup();
    f.machines[0] = testMachine({ id: 'first', aliases: [], limits: { ...testMachine().limits, keepJobs: 1 } });
    writeFiles(f.environments[0].remoteRoot, { 'jobs/retained/.fleet-job': '', 'jobs/retained/artifacts.pending': '', 'jobs/retained/artifacts.tar': 'only-result' });
    try {
      const request = { ...f.request, automatic: !pinned, machines: pinned ? [f.machines[0]] : f.machines };
      if (pinned) await assert.rejects(() => runOnOrderedMachines(request), /No available remote workers/);
      else assert.equal((await runOnOrderedMachines(request)).receipt.machine.id, 'second');
      assert.deepEqual(f.transports.map(t => t.admissions), pinned ? [0, 0] : [0, 1]);
      assert.equal(readFileSync(join(f.environments[0].remoteRoot, 'jobs/retained/artifacts.tar'), 'utf8'), 'only-result');
      assert.equal(existsSync(join(f.environments[0].remoteRoot, 'jobs/retained/artifacts.pending')), true);
    } finally { f.cleanup(); }
  });
}

test('a pending cap filled after preflight refuses before upload or hooks and advances only once', { timeout: 30000 }, async () => {
  const f = setup('echo command >> "$HOME/hooks"; echo tests 1', {}, {
    prepare: [['bash', '-c', 'echo prepare >> "$HOME/hooks"']],
    finalizer: { argv: ['bash', '-c', 'echo finalizer >> "$HOME/hooks"'], timeoutSeconds: 3 },
  });
  f.machines[0] = testMachine({ id: 'first', aliases: [], limits: { ...testMachine().limits, maxConcurrentJobs: 2, keepJobs: 1 } });
  // Choose this ship deterministically: live disk observations on the same
  // test volume can differ while another fixture writes its own files.
  f.transports[0].preflightValues['load_average'] = '0 0 0';
  f.transports[1].preflightValues['load_average'] = '10 10 10';
  const transport = f.transports[0];
  const start = transport.start.bind(transport);
  transport.start = command => {
    if (command.includes('fleet-runner-supervisor')) writeFiles(f.environments[0].remoteRoot, {
      'jobs/retained/.fleet-job': '', 'jobs/retained/artifacts.pending': '', 'jobs/retained/artifacts.tar': 'only-result',
    });
    return start(command);
  };
  try {
    const run = await runOnOrderedMachines({ ...f.request, automatic: true });
    assert.equal(run.receipt.outcome, 'passed', JSON.stringify(run.receipt));
    assert.equal(run.receipt.machine.id, 'second');
    assert.deepEqual(f.transports.map(t => t.admissions), [1, 1]);
    assert.equal(existsSync(join(f.environments[0].remoteHome, 'hooks')), false);
    assert.equal(readFileSync(join(f.environments[1].remoteHome, 'hooks'), 'utf8'), 'prepare\ncommand\nfinalizer\n');
    assert.deepEqual(readdirSync(join(f.environments[0].remoteRoot, 'jobs')), ['retained']);
    assert.deepEqual(readdirSync(join(f.environments[0].remoteRoot, 'locks/shared')), []);
    assert.equal(transport.commands.length, 2, 'only preflight and the refused supervisor; no upload connection');
    assert.equal(readFileSync(join(f.environments[0].remoteRoot, 'jobs/retained/artifacts.tar'), 'utf8'), 'only-result');
  } finally { f.cleanup(); }
});

test('automatic ranking uses pressure, load per CPU, reservations and memory before preference', () => {
  const machine = testMachine();
  const base = { machine, used: 0, report: report('normal', { memPressureLevel: 1, cpuCount: 10, loadAverage: [1], memAvailableBytes: 4 * 1024 ** 3 }) };
  assert.ok(compareWorkerLoad(base, { ...base, report: { ...base.report, memPressureLevel: 2, loadAverage: [0] } }) < 0);
  assert.ok(compareWorkerLoad(base, { ...base, report: { ...base.report, cpuCount: 2 } }) < 0);
  assert.ok(compareWorkerLoad(base, { ...base, used: 1 }) < 0);
  assert.ok(compareWorkerLoad(base, { ...base, report: { ...base.report, memAvailableBytes: 1024 ** 3 } }) < 0);
  assert.equal(compareWorkerLoad(base, base), 0);
  assert.ok(compareWorkerLoad(base, { ...base, report: report('unknown') }) < 0);
});

test('explicit worker order preserves names and rejects repeated physical aliases', () => {
  const first = testMachine();
  const second = testMachine({ id: 'm1max', transport: { kind: 'agent-bridge', target: 'Second' }, aliases: [] });
  const registry = { schemaVersion: 1 as const, machines: [first, second] };
  assert.deepEqual(orderedMachines(registry, ['m1max', 'mini']).map((machine) => machine.id), ['m1max', 'mini']);
  assert.throws(() => orderedMachines(registry, ['mini', 'Mac-Mini']), /more than once/);
  assert.throws(() => orderedMachines(registry, ['missing']), /Unknown machine/);
  assert.throws(() => orderedMachines(registry, ['']), /comma-separated/);
});

test('default-first worker order resolves aliases and preserves the inventory', () => {
  const first = testMachine();
  const second = testMachine({ id: 'second', aliases: ['preferred'], transport: { kind: 'agent-bridge', target: 'Second' } });
  const registry = { schemaVersion: 1 as const, machines: [first, second] };
  assert.deepEqual(defaultMachineNames(registry), ['mini', 'second']);
  assert.deepEqual(defaultMachineNames({ ...registry, defaultMachine: 'preferred' }), ['second', 'mini']);
  assert.deepEqual(defaultMachineNames({ ...registry, defaultMachine: 'SECOND' }), ['second', 'mini']);
  assert.deepEqual(defaultMachineNames({ ...registry, defaultMachine: 'mini' }), ['mini', 'second']);
  assert.deepEqual(registry.machines.map(machine => machine.id), ['mini', 'second']);
  assert.deepEqual(defaultMachineNames({ schemaVersion: 1, machines: [] }), []);
});

test('cancellation during a busy refusal does not dispatch the next worker', { timeout: 30000 }, async () => {
  const fixture = setup();
  const interrupts = new Interrupts();
  fixture.transports[0].admission = 'busy';
  fixture.transports[0].onBusy = () => { interrupts.trigger(); };
  try {
    await assert.rejects(() => runOnOrderedMachines({ ...fixture.request, interrupts }), /cancelled before admission/);
    assert.deepEqual(fixture.transports.map((transport) => transport.admissions), [1, 0]);
  } finally { fixture.cleanup(); }
});

test('conclusive busy admission advances to next controlled worker', { timeout: 30000 }, async () => {
  const fixture = setup();
  fixture.transports[0].admission = 'busy';
  try {
    const run = await runOnOrderedMachines(fixture.request);
    assert.equal(run.receipt.outcome, 'passed', JSON.stringify(run.receipt));
    assert.equal(run.receipt.machine.id, 'second');
    assert.deepEqual(fixture.transports.map((transport) => transport.admissions), [1, 1]);
  } finally { fixture.cleanup(); }
});

for (const kind of ['uncertain', 'failed-test'] as const) {
  test(`${kind} never retries another worker`, { timeout: 30000 }, async () => {
    const fixture = setup(kind === 'failed-test' ? 'echo tests 1; exit 7' : undefined);
    if (kind === 'uncertain') fixture.transports[0].admission = 'uncertain';
    try {
      const run = await runOnOrderedMachines(fixture.request);
      assert.notEqual(run.receipt.outcome, 'passed');
      assert.equal(run.admission, kind === 'uncertain' ? 'uncertain' : 'admitted');
      assert.equal(run.receipt.machine.id, 'first');
      assert.deepEqual(fixture.transports.map((transport) => transport.admissions), [1, 0]);
    } finally { fixture.cleanup(); }
  });
}

test('a transport error after actual command execution never dispatches another ship', { timeout: 30000 }, async () => {
  const f = setup('echo command >> "$HOME/executed"; echo tests 1');
  f.transports[0].loseResult = true;
  try {
    const run = await runOnOrderedMachines(f.request);
    assert.equal(run.admission, 'admitted');
    assert.equal(run.receipt.outcome, 'error');
    assert.equal(run.receipt.remote.lockReleased, false, 'no release confirmation crossed the failed transport');
    assert.deepEqual(f.transports.map(t => t.admissions), [1, 0]);
    assert.equal(readFileSync(join(f.environments[0].remoteHome, 'executed'), 'utf8'), 'command\n');
    assert.equal(existsSync(join(f.environments[1].remoteHome, 'executed')), false);
  } finally { f.cleanup(); }
});

test('machine env requirements skip incompatible worker and use selected env', { timeout: 30000 }, async () => {
  const fixture = setup('test "$DOCKER_CONTEXT" = isolated-second; echo tests 1', { machineEnv: ['DOCKER_CONTEXT'] });
  fixture.machines[1] = testMachine({ id: 'second', aliases: [], env: { DOCKER_CONTEXT: 'isolated-second' } });
  try {
    const run = await runOnOrderedMachines(fixture.request);
    assert.equal(run.receipt.outcome, 'passed', JSON.stringify(run.receipt));
    assert.equal(run.receipt.machine.id, 'second');
    assert.deepEqual(fixture.transports.map((transport) => transport.admissions), [0, 1]);
  } finally { fixture.cleanup(); }
});

test('automatic selection excludes the dispatching physical computer', { timeout: 30000 }, async () => {
  const fixture = setup();
  try {
    const report = await fetchPreflight(fixture.transports[0], fixture.machines[0], [], []);
    const fingerprint = report.fingerprint;
    assert.ok(fingerprint);
    await assert.rejects(() => runOnOrderedMachines({ ...fixture.request, machines: [fixture.machines[0]], dispatcherFingerprint: fingerprint }), /No available remote workers/);
    assert.deepEqual(fixture.transports.map((transport) => transport.admissions), [0, 0]);
  } finally { fixture.cleanup(); }
});

test('two registry names for one physical worker do not bypass busy admission', { timeout: 30000 }, async () => {
  const fixture = setup();
  fixture.transports[0].admission = 'busy';
  fixture.transports[1].fingerprint = fixture.transports[0].fingerprint;
  try {
    await assert.rejects(() => runOnOrderedMachines(fixture.request), /No available remote workers/);
    assert.deepEqual(fixture.transports.map((transport) => transport.admissions), [1, 0]);
  } finally { fixture.cleanup(); }
});
