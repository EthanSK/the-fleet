// Projects, profile runs and finished-run history through the local API.
// Execution is injected; the CLI run path, coordinator admission, operation
// lifecycle, abandonment sweep and receipt index are the real ones.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { registerProject } from '../src/registry.ts';
import { recordRun } from '../src/service/catalog.ts';
import type { RunRequest, RunResult } from '../src/run/runJob.ts';
import { report, startServiceFixture, writeRun, type ServiceFixture } from './helpers/serviceFixture.ts';

function registerExample(f: ServiceFixture): void {
  const source = join(f.root, 'example'); mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'package.json'), '{}\n');
  writeFileSync(join(source, 'fleet.json'), JSON.stringify({ schemaVersion: 1, id: 'example', description: 'Example project', sync: { include: ['package.json', 'fleet.json'] },
    profiles: {
      test: { description: 'Run tests', kind: 'test', argv: ['npm', 'test'], timeoutMinutes: 5, env: { API_SECRET: 'hidden-value' },
        requires: { tools: ['node'] }, success: { minTestCount: { pattern: 'tests (\\d+)', min: 1 } } },
      device: { description: 'Physical device check', kind: 'test', argv: ['true'], timeoutMinutes: 1, blocked: 'Needs the attached device' },
    },
    localOnly: [{ command: 'npm run device', reason: 'Uses the attached hardware' }] }));
  registerProject(f.paths, join(source, 'fleet.json'), source, false);
}

async function addWorker(f: ServiceFixture): Promise<void> {
  const revision = String((await f.call('GET', '/v1/config')).body['revision']);
  assert.equal((await f.call('POST', '/v1/machines', { revision, id: 'mini', target: 'Mac-Mini' })).status, 200);
  f.reports.set('Mac-Mini', report('fp-mini'));
}

async function until(condition: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) throw new Error('Condition not reached in time.');
    await new Promise((done) => setTimeout(done, 20));
  }
}

/** Execution that runs until the test finishes it or the run is cancelled. */
function controllableExecution(storeFor: (request: RunRequest) => string) {
  const finishers: (() => void)[] = [];
  let count = 0;
  const execute = (request: RunRequest): Promise<RunResult> => new Promise((resolve) => {
    count += 1;
    const jobId = `20261101-12000${count}-example-test-00000${count}`;
    request.interrupts?.onInterrupt(() => resolve(writeRun(storeFor(request), jobId, { outcome: 'cancelled' })));
    finishers.push(() => resolve(writeRun(storeFor(request), jobId, { stdout: `${'x'.repeat(3000)}\n# tests 3\n` })));
  });
  return { execute, finish: (index: number) => finishers[index]?.() };
}

test('API cancellation is idempotent; an explicit force disconnect signals only once more', async () => {
  const counts: number[] = [];
  let finish: (() => void) | undefined;
  const f = await startServiceFixture({ execute: (request) => new Promise((resolve) => {
    request.interrupts?.onInterrupt((count) => counts.push(count));
    finish = () => resolve(writeRun(request.paths.runsDir, `20261102-cancel-fixture-${f.executed.length}`, { outcome: 'cancelled' }));
  }) });
  try {
    registerExample(f); await addWorker(f);
    for (const forceFirst of [false, true]) {
      counts.length = 0;
      const previous = f.executed.length;
      const response = await f.call('POST', '/v1/projects/example/run', { profile: 'test', machine: 'mini' });
      const id = String(response.body['operationId']);
      await until(async () => f.executed.length > previous);
      assert.equal((await f.call('POST', `/v1/operations/${id}/cancel`, forceFirst ? { forceDisconnect: true } : undefined)).status, 200);
      await f.call('POST', `/v1/operations/${id}/cancel`, {});
      assert.deepEqual(counts, forceFirst ? [1, 2] : [1]);
      await f.call('POST', `/v1/operations/${id}/cancel`, { forceDisconnect: true });
      await f.call('POST', `/v1/operations/${id}/cancel`, { forceDisconnect: true });
      assert.deepEqual(counts, [1, 2]);
      finish?.();
      await until(async () => (await f.call('GET', `/v1/operations/${id}`)).body['status'] === 'complete');
    }
  } finally { finish?.(); await f.close(); }
});

test('the real CLI preserves intentional second-Ctrl-C force disconnect', async () => {
  const counts: number[] = [];
  let finish: (() => void) | undefined;
  const f = await startServiceFixture({ execute: (request) => new Promise((resolve) => {
    request.interrupts?.onInterrupt((count) => counts.push(count));
    finish = () => resolve(writeRun(request.paths.runsDir, '20261102-cli-cancel-fixture', { outcome: 'cancelled' }));
  }) });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    registerExample(f); await addWorker(f);
    child = spawn(process.execPath, [fileURLToPath(new URL('../bin/the-fleet.js', import.meta.url)), 'run', 'example', 'test', '--machine', 'mini'],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, THE_FLEET_HOME: f.paths.home } });
    const exit = new Promise<number | null>((resolve, reject) => { child!.once('exit', resolve); child!.once('error', reject); });
    await until(async () => f.executed.length === 1);
    child.kill('SIGINT'); await until(async () => counts.length === 1);
    child.kill('SIGINT'); await until(async () => counts.length === 2);
    assert.deepEqual(counts, [1, 2]);
    finish?.();
    assert.equal(await exit, 7);
  } finally { finish?.(); child?.kill('SIGTERM'); await f.close(); }
});

test('projects summarize live manifests without environment values and isolate a broken manifest', async () => {
  const f = await startServiceFixture();
  try {
    registerExample(f);
    const other = join(f.root, 'broken'); mkdirSync(other);
    writeFileSync(join(other, 'fleet.json'), JSON.stringify({ schemaVersion: 1, id: 'broken', sync: { include: ['x'] }, profiles: { check: { description: 'c', kind: 'check', argv: ['true'], timeoutMinutes: 1 } } }));
    registerProject(f.paths, join(other, 'fleet.json'), other, false);
    writeFileSync(join(other, 'fleet.json'), '{ not json');

    const reply = await f.call('GET', '/v1/projects');
    const projects = reply.body['projects'] as Record<string, unknown>[];
    const example = projects.find((project) => project['id'] === 'example')!;
    const profiles = example['profiles'] as Record<string, unknown>[];
    assert.deepEqual(profiles.map((profile) => profile['name']), ['test', 'device']);
    assert.equal(profiles[0]?.['success'], 'exit 0 · at least 1 test(s) via /tests (\\d+)/');
    assert.equal(profiles[1]?.['blocked'], 'Needs the attached device');
    assert.deepEqual(example['localOnly'], [{ command: 'npm run device', reason: 'Uses the attached hardware' }]);
    assert.doesNotMatch(reply.text, /hidden-value/);
    assert.match(String(projects.find((project) => project['id'] === 'broken')?.['error']), /not valid JSON/);
  } finally { await f.close(); }
});

test('a plan reads the source a run would send without contacting a worker', async () => {
  const f = await startServiceFixture();
  try {
    registerExample(f); await addWorker(f);
    const plan = await f.call('POST', '/v1/projects/example/plan', { profile: 'test' });
    assert.equal(plan.status, 200, plan.text);
    assert.equal((plan.body['source'] as { files: number }).files, 2);
    assert.equal(plan.body['machine'], 'mini');
    assert.deepEqual(plan.body['command'], ['npm', 'test']);
    assert.match((await f.call('POST', '/v1/projects/example/plan', { profile: 'device' })).body['error'] as string, /blocked/);
    assert.equal(f.executed.length, 0);
  } finally { await f.close(); }
});

test('a detached profile run outlives its client; an ordinary one is cancelled; observing never keeps work alive', async () => {
  const control = controllableExecution((request) => request.paths.runsDir);
  const f = await startServiceFixture({ execute: control.execute, abandonAfterMs: 200, sweepIntervalMs: 20 });
  try {
    registerExample(f); await addWorker(f);
    assert.match((await f.call('POST', '/v1/projects/example/run', { profile: 'device' })).body['error'] as string, /blocked/);
    assert.equal((await f.call('POST', '/v1/projects/example/run', { profile: 'test', bogus: 1 })).status, 400);

    const ordinary = await f.call('POST', '/v1/projects/example/run', { profile: 'test', machine: 'mini', owner: 'dashboard' });
    assert.equal(ordinary.status, 202, ordinary.text);
    const ordinaryId = String(ordinary.body['operationId']);
    // Watching through observe=1 is not a heartbeat, so the abandoned run is cancelled.
    await until(async () => (await f.call('GET', `/v1/operations/${ordinaryId}?observe=1`)).body['status'] === 'complete');
    const cancelled = await f.call('GET', `/v1/operations/${ordinaryId}?observe=1`);
    assert.equal(cancelled.body['exitCode'], 7, cancelled.text);
    assert.equal(cancelled.body['cancelRequested'], true);

    const detached = await f.call('POST', '/v1/projects/example/run', { profile: 'test', machine: 'mini', owner: 'The Fleet app', detached: true });
    const detachedId = String(detached.body['operationId']);
    await until(async () => f.executed.length === 2);
    await new Promise((done) => setTimeout(done, 400));
    const list = (await f.call('GET', '/v1/operations')).body['operations'] as Record<string, unknown>[];
    const running = list.find((operation) => operation['id'] === detachedId)!;
    assert.equal(running['status'], 'running', 'nobody polled it, and it kept running');
    assert.equal(running['machineId'], 'mini'); assert.equal(running['label'], 'example/test'); assert.equal(running['detached'], true);
    control.finish(1);
    await until(async () => (await f.call('GET', `/v1/operations/${detachedId}?observe=1`)).body['status'] === 'complete');
    const finished = await f.call('GET', `/v1/operations/${detachedId}?observe=1`);
    assert.equal(finished.body['exitCode'], 0, finished.text);
    assert.deepEqual(finished.body['jobIds'], ['20261101-120002-example-test-000002']);
    assert.deepEqual((await f.call('GET', '/v1/state')).body['reservations'], [], 'both runs released their ownership');
  } finally { await f.close(); }
});

test('history covers every run store a coordinated run used and reports removed receipts honestly', async () => {
  let external = '';
  const control = controllableExecution(() => external);
  const f = await startServiceFixture({ execute: control.execute });
  try {
    external = join(f.root, 'external.noindex'); mkdirSync(external);
    registerExample(f); await addWorker(f);
    writeRun(f.paths.runsDir, '20261031-090000-example-test-aaaaaa', { outcome: 'failed', finishedAt: '2026-10-31T09:00:00.000Z' });
    const started = await f.call('POST', '/v1/command', { owner: 'cli', cwd: f.root, argv: ['run', 'example', 'test', '--machine', 'mini'], runsDirectory: external });
    assert.equal(started.status, 202, started.text);
    await until(async () => f.executed.length === 1);
    control.finish(0);
    const operationId = String(started.body['operationId']);
    await until(async () => (await f.call('GET', `/v1/operations/${operationId}`)).body['status'] === 'complete');

    const runs = (await f.call('GET', '/v1/runs')).body['runs'] as Record<string, unknown>[];
    assert.deepEqual(runs.map((run) => run['jobId']), ['20261101-120001-example-test-000001', '20261031-090000-example-test-aaaaaa']);
    assert.equal(runs[0]?.['directory'], join(external, '20261101-120001-example-test-000001'));
    assert.equal(runs[0]?.['owner'], 'cli'); assert.equal(runs[0]?.['testCount'], 3); assert.equal(runs[1]?.['outcome'], 'failed');

    const detail = await f.call('GET', '/v1/runs/20261101-120001-example-test-000001?tail=1024');
    const stdout = (detail.body['logs'] as { stdout: { text: string; truncated: boolean; bytes: number } }).stdout;
    assert.equal(stdout.truncated, true); assert.ok(stdout.text.length <= 1024); assert.match(stdout.text, /# tests 3/);
    assert.equal((detail.body['receipt'] as { jobId: string }).jobId, '20261101-120001-example-test-000001');

    rmSync(join(external, '20261101-120001-example-test-000001'), { recursive: true });
    const pruned = ((await f.call('GET', '/v1/runs')).body['runs'] as Record<string, unknown>[])[0]!;
    assert.equal(pruned['available'], false); assert.equal(pruned['outcome'], 'passed', 'the index still says what happened');
    assert.equal((await f.call('GET', '/v1/runs/20261101-120001-example-test-000001')).body['available'], false);
    assert.equal((await f.call('GET', '/v1/runs/..%2F..%2Fetc')).status, 400);
    assert.equal((await f.call('GET', '/v1/runs/20200101-000000-none-test-000000')).status, 404);
    assert.equal((await f.call('GET', '/v1/runs?project=example&limit=1')).body['runs'] instanceof Array, true);
  } finally { await f.close(); }
});

test('resource measurements survive pruning without retaining the full job folder', async () => {
  const f = await startServiceFixture();
  const resources = { sampleCount: 3, sampleIntervalSeconds: 5 as const, peakRssKiB: 32768, peakProcessCpuPercent: 185.2 };
  const placement = { strategy: 'load-aware' as const, pressureLevel: 1, loadPerCpu: 0.4, occupiedSlots: 1 };
  try {
    const result = writeRun(f.paths.runsDir, '20261105-resource-history-fixture', { resources, placement });
    recordRun(f.paths, result, { operationId: 'fixture', owner: 'history-test' });
    const read = async () => ((await f.call('GET', '/v1/runs')).body['runs'] as Record<string, unknown>[])[0];
    assert.deepEqual((await read())?.['resources'], resources);
    rmSync(join(f.paths.runsDir, result.receipt.jobId), { recursive: true });
    const pruned = await read();
    assert.equal(pruned?.['available'], false);
    assert.deepEqual(pruned?.['resources'], resources);
    assert.deepEqual(pruned?.['placement'], placement);
    assert.equal(pruned?.['jobSeconds'], result.receipt.timing.jobSeconds);
    assert.equal(pruned?.['sourceDigest'], result.receipt.source.digest);
  } finally { await f.close(); }
});

test('health reports the running version so apps can tell an older service apart', async () => {
  const f = await startServiceFixture();
  try {
    const health = await f.call('GET', '/v1/health');
    assert.equal(health.body['application'], 'The Fleet'); assert.equal(health.body['protocolVersion'], 1);
    assert.match(String(health.body['version']), /^\d+\.\d+\.\d+$/);
    const unknown = await f.call('GET', '/v1/nothing');
    assert.equal(unknown.status, 404); assert.equal(unknown.body['code'], 'unknown-route');
  } finally { await f.close(); }
});
