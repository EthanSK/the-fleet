// Foreground cleanup must prove ownership, serialize with other apps and keep
// uncertainty visible. These fixtures never touch an actual worker's files.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Coordinator, type CoordinatorDependencies } from '../src/service/coordinator.ts';
import { inlineProject } from '../src/service/server.ts';
import { assessMemory } from '../src/run/memoryAssessment.ts';
import { evaluatePreflight, parsePreflight } from '../src/run/preflight.ts';
import { fetchPreflight, runControl } from '../src/run/remoteChecks.ts';
import { report } from './helpers/serviceFixture.ts';
import { testEnvironment, testMachine, writeFiles } from './helpers/fixtures.ts';
import type { RunRequest, RunResult } from '../src/run/runJob.ts';

function fixture() {
  const env = testEnvironment();
  let machine = testMachine();
  let current = report('worker');
  let calls = 0;
  let now = Date.now();
  let execute: (request: RunRequest) => Promise<RunResult> = async () => { throw new Error('not executed'); };
  let cleanup: NonNullable<CoordinatorDependencies['cleanupStale']> = async () => {
    current = report('worker'); return { result: 'cleared', detail: 'old' };
  };
  const dependencies: CoordinatorDependencies = {
    machines: () => [machine, { ...machine, id: 'alias' }], now: () => now,
    localFingerprint: async () => 'dispatcher',
    inspect: async (value) => ({ machine: value, observedAt: new Date().toISOString(), report: current }),
    route: () => ({ target: 'fixture', host: '192.0.2.1', user: 'tester', port: 22, path: 'internet' }),
    execute: (request) => execute(request),
    cleanupStale: async (value, jobId) => { calls++; assert.equal(jobId, 'old'); return cleanup(value, jobId); },
  };
  const coordinator = new Coordinator(env.paths, dependencies);
  return { env, coordinator, dependencies, setReport: (value: typeof current) => { current = value; },
    setMachine: (value: typeof machine) => { machine = value; },
    setCleanup: (value: typeof cleanup) => { cleanup = value; }, setExecute: (value: typeof execute) => { execute = value; },
    calls: () => calls, advance: () => { now += 60_000; } };
}
const stale = () => report('worker', { lock: { state: 'stale', jobId: 'old', label: 'fixture' } });

test('state remains read-only; foreground maintenance clears an exact abandoned job', async () => {
  const f = fixture();
  try {
    f.setReport(stale());
    await f.coordinator.state(true);
    assert.equal(f.calls(), 0);
    assert.equal((await f.coordinator.maintain('mini')).cleanup.status, 'cleared');
    assert.equal(f.calls(), 1);
    assert.equal(f.coordinator.reservationsFor(testMachine()).length, 0);
  } finally { f.env.cleanup(); }
});

test('active, expired and restarted external reservations all prevent automatic cleanup', async () => {
  const f = fixture();
  try {
    await f.coordinator.reserve('another-app', 'external work', ['mini'], 15);
    f.setReport(stale());
    assert.equal((await f.coordinator.maintain('alias')).cleanup.status, 'reserved');
    f.advance();
    assert.equal((await f.coordinator.maintain('mini')).cleanup.status, 'reserved');
    assert.equal(f.coordinator.reservationsFor(testMachine())[0]?.state, 'expired');
    const restarted = new Coordinator(f.env.paths, f.dependencies);
    assert.equal((await restarted.maintain('mini')).cleanup.status, 'reserved');
    assert.equal(f.calls(), 0);
  } finally { f.env.cleanup(); }
});

test('maintenance holds physical ownership across async cleanup and retains uncertain work', async () => {
  const f = fixture();
  try {
    f.setReport(stale());
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      f.setCleanup(async () => { resolve(); await new Promise<void>((done) => { finish = done; }); throw new Error('lost connection'); });
    });
    const running = f.coordinator.maintain('mini');
    await started;
    assert.equal(f.coordinator.maintenanceInProgress, true);
    assert.equal((await f.coordinator.maintain('alias')).cleanup.status, 'reserved');
    await assert.rejects(f.coordinator.reserve('another-app', 'work', ['alias']), /No available worker/);
    finish();
    assert.equal((await running).cleanup.status, 'unverified');
    assert.equal(f.coordinator.reservationsFor(testMachine())[0]?.state, 'unverified');
    assert.equal(f.coordinator.maintenanceInProgress, false);
    f.setReport(report('worker'));
    assert.equal((await f.coordinator.recoverManaged()).length, 1);
  } finally { f.env.cleanup(); }
});

test('active managed work is preserved even when its remote lock looks stale', async () => {
  const f = fixture();
  let finish!: () => void;
  let running: Promise<RunResult | null> | undefined;
  try {
    const started = new Promise<void>((resolve) => { f.setExecute(async () => {
      resolve(); await new Promise<void>((done) => { finish = done; }); throw new Error('fixture finished');
    }); });
    const oneTime = inlineProject({ source: '.', files: ['source'], command: ['true'], timeoutMinutes: 1, kind: 'check' }, f.env.root);
    running = f.coordinator.runOne('another-app', 'managed-operation', { ...oneTime, paths: f.env.paths,
      machine: testMachine(), transport: f.env.transport, preflightReport: report('worker'), extraArgs: [], ignoreHeavyProcesses: false,
      io: { stdout: f.env.stdout, stderr: f.env.stderr, status: () => {} } });
    await started;
    f.setReport(stale());
    assert.equal((await f.coordinator.maintain('alias')).cleanup.status, 'reserved');
    assert.equal(f.calls(), 0);
    finish();
    await assert.rejects(running, /fixture finished/);
  } finally { f.env.cleanup(); }
});

test('configuration changes during inspection prevent cleanup on the former destination', async () => {
  const f = fixture();
  try {
    f.setReport(stale());
    const inspect = f.dependencies.inspect;
    const coordinator = new Coordinator(f.env.paths, { ...f.dependencies, inspect: async (machine) => {
      const observation = await inspect(machine);
      f.setMachine({ ...testMachine(), remoteRoot: '~/different.noindex' });
      return observation;
    } });
    assert.equal((await coordinator.maintain('mini')).cleanup.status, 'unverified');
    assert.equal(f.calls(), 0);
  } finally { f.env.cleanup(); }
});

test('busy/orphaned, local, incomplete and unknown-owner checks never auto-clean', async () => {
  const f = fixture();
  try {
    for (const value of [report('worker', { lock: { state: 'busy', jobId: 'old', label: 'fixture', orphaned: true } }),
      report('dispatcher', { lock: stale().lock }), report('worker', { complete: false }),
      report('worker', { lock: { state: 'stale', jobId: '-', label: '-' } })]) {
      f.setReport(value); await f.coordinator.maintain('mini');
    }
    assert.equal(f.calls(), 0);
  } finally { f.env.cleanup(); }
});

test('real guarded auto-clean preserves evidence and refuses changed, unmarked and symlink jobs', async () => {
  const env = testEnvironment();
  const machine = testMachine();
  const job = join(env.remoteRoot, 'jobs', 'old');
  const lock = join(env.remoteRoot, 'locks', 'heavy');
  try {
    mkdirSync(lock, { recursive: true });
    writeFiles(job, { 'derived.noindex/file': 'scratch', 'stdout.log': 'evidence' });
    writeFileSync(join(lock, 'owner'), `job_id=old\nsupervisor_pid=99999999\njob_dir=${job}\n`);
    assert.equal((await runControl(env.transport, machine, 'reap-stale', 'old')).result, 'unverified');
    writeFileSync(join(job, '.fleet-job'), '');
    assert.equal((await runControl(env.transport, machine, 'reap-stale', 'different')).result, 'unverified');
    rmSync(join(job, '.fleet-job'));
    writeFileSync(join(env.remoteHome, 'marker'), '');
    symlinkSync(join(env.remoteHome, 'marker'), join(job, '.fleet-job'));
    assert.equal((await runControl(env.transport, machine, 'reap-stale', 'old')).result, 'unverified');
    rmSync(join(job, '.fleet-job'));
    writeFileSync(join(job, '.fleet-job'), '');
    assert.equal(existsSync(lock), true);
    assert.equal((await runControl(env.transport, machine, 'reap-stale', 'old')).result, 'cleared');
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(join(job, 'derived.noindex')), false);
    assert.equal(readFileSync(join(job, 'stdout.log'), 'utf8'), 'evidence');
    assert.match(readFileSync(join(job, 'result'), 'utf8'), /reason=abandoned/);
  } finally { env.cleanup(); }
});

test('process inspection reports bounded executable-only RSS; swap never implies a leak or refusal', async () => {
  const env = testEnvironment();
  try {
    const actual = await fetchPreflight(env.transport, testMachine(), [], []);
    assert.equal(actual.processSampleComplete, true);
    assert.ok((actual.processes?.length ?? 0) > 0 && (actual.processes?.length ?? 0) <= 20);
    for (const row of actual.processes ?? []) assert.equal(row.name.includes('/'), false);
    const value = report('worker', { swapUsedMiB: 999_999, processes: [{ pid: 1, ppid: 0, pgid: 1, uid: 0,
      rssKiB: 4 * 1024 ** 2, cpuPercent: 1, elapsed: '100-00:00:00', name: 'system-service' }], processSampleComplete: true });
    const assessment = assessMemory(value);
    assert.equal(assessment.leakAssessment, 'not-established-by-snapshot');
    assert.equal(assessment.highResidentProcesses[0]?.ownership, 'unverified');
    assert.deepEqual(evaluatePreflight(value, testMachine(), undefined, { ignoreHeavyProcesses: false, nowEpoch: 0 }).refusals, []);
    assert.equal(parsePreflight('processes_json=broken\nprocess_sample=1\ndone=1').processSampleComplete, false);
  } finally { env.cleanup(); }
});
