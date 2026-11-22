import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { runProfile } from '../src/run/runJob.ts';
import type { Receipt } from '../src/run/receipt.ts';
import { inlineProject } from '../src/service/server.ts';
import { parseManifest } from '../src/schema/manifest.ts';
import { report, startServiceFixture } from './helpers/serviceFixture.ts';
import { waitUntil, writeFiles } from './helpers/fixtures.ts';
import { AdmissionTransport } from './helpers/admissionTransport.ts';

const manifest = () => ({ schemaVersion: 1, id: 'stable-project',
  sync: { include: ['source/**'], exclude: ['source/excluded'], maxTotalMiB: 10, maxFileMiB: 2 },
  profiles: { check: { description: 'Fixture check', kind: 'check', argv: ['bash', 'source/run.sh'], timeoutMinutes: 1, env: { EXAMPLE: 'value' },
    pathPrepend: ['~/bin'], extraInputs: ['fixtures/**'], isolatedTmp: true, artifacts: ['report.txt'], maxArtifactMiB: 3,
    finalizer: { argv: ['bash', 'source/clean.sh'], timeoutSeconds: 10 }, cache: { name: 'stable-cache', maxGiB: 1 }, sourceTransfer: 'rsync' } } });

test('full-manifest submit preserves the entire existing contract without another cache identity', () => {
  const value = manifest();
  const one = inlineProject({ source: '.', manifest: value, profile: 'check' }, '/tmp/example');
  assert.deepEqual(one.project.manifest, parseManifest(value, 'reference'));
  assert.equal(one.sourceRoot, '/tmp/example');
  assert.equal(one.profileName, 'check');
  assert.throws(() => inlineProject({ source: '.', manifest: value, profile: 'absent' }, '/tmp'), /no profile/);
  assert.throws(() => inlineProject({ source: '.', manifest: value, profile: 'check', command: ['true'] }, '/tmp'), /Unknown full-manifest/);
  const unsafe = manifest(); unsafe.profiles.check.finalizer.timeoutSeconds = 301;
  assert.throws(() => inlineProject({ source: '.', manifest: unsafe, profile: 'check' }, '/tmp'), /timeoutSeconds/);
});

test('inline dry-run uses the real planner, detects edits, honours exclusions and creates no operation/registration', async () => {
  const f = await startServiceFixture();
  try {
    const revision = (await f.call('GET', '/v1/config')).body['revision'];
    f.reports.set('Mac-Mini', report('worker'));
    assert.equal((await f.call('POST', '/v1/machines', { revision, id: 'mini', target: 'Mac-Mini' })).status, 200);
    const source = join(f.root, 'source-tree');
    writeFiles(source, { 'source/run.sh': 'echo original', 'source/clean.sh': 'true', 'source/excluded': 'excluded', 'source/.env': 'synthetic-secret', 'fixtures/input': 'fixture' });
    const input = { cwd: f.root, request: { source, manifest: manifest(), profile: 'check' } };
    const first = await f.call('POST', '/v1/submit/plan', input);
    assert.equal(first.status, 200, first.text);
    const snapshot = first.body['source'] as { digest: string; files: number };
    assert.equal(snapshot.files, 3);
    assert.equal((await f.call('GET', '/v1/operations')).body['operations'] instanceof Array, true);
    assert.deepEqual((await f.call('GET', '/v1/operations')).body['operations'], []);
    assert.deepEqual((await f.call('GET', '/v1/projects')).body['projects'], []);
    writeFiles(source, { 'source/excluded': 'changed excluded file' });
    assert.equal(((await f.call('POST', '/v1/submit/plan', input)).body['source'] as { digest: string }).digest, snapshot.digest);
    writeFiles(source, { 'source/run.sh': 'echo edited' });
    assert.notEqual(((await f.call('POST', '/v1/submit/plan', input)).body['source'] as { digest: string }).digest, snapshot.digest);
    assert.equal(f.executed.length, 0);
  } finally { await f.close(); }
});

test('full-manifest API runs the real supervisor, finalizer and artifact contract with stable CLI markers', { timeout: 30_000 }, async () => {
  let executionDone = false;
  const f = await startServiceFixture({ transportFor: (_machine, home) => new AdmissionTransport(home), execute: async (request) => {
    try { return await runProfile(request); } finally { executionDone = true; }
  } });
  try {
    const revision = (await f.call('GET', '/v1/config')).body['revision'];
    f.reports.set('Mac-Mini', report('worker'));
    assert.equal((await f.call('POST', '/v1/machines', { revision, id: 'mini', target: 'Mac-Mini', limits: {
      minFreeDiskGiB: 0, minAvailableMemoryGiB: 0, memoryPressure: 'report-only', heavyProcessAction: 'warn',
    } })).status, 200);
    const source = join(f.root, 'source-tree');
    writeFiles(source, { 'source/run.sh': 'echo tests 1; echo result > report.txt', 'source/clean.sh': 'echo finalized >> report.txt', 'fixtures/input': 'fixture' });
    const full = manifest();
    full.profiles.check.sourceTransfer = 'tar';
    const submitted = await f.call('POST', '/v1/submit', { cwd: f.root, owner: 'integration-fixture', request: { source, manifest: full, profile: 'check' } });
    assert.equal(submitted.status, 202, submitted.text);
    const id = String(submitted.body['operationId']);
    assert.equal(await waitUntil(() => executionDone, 20_000), true);
    const result = (await f.call('GET', `/v1/operations/${id}`)).body;
    assert.equal(result['status'], 'complete');
    assert.equal(result['exitCode'], 0, JSON.stringify(result));
    const output = String(result['output']);
    assert.match(output, /^fleet-runner: Started on /m);
    assert.match(output, /Job ended on mini\. Waiting for output and cleanup\.[\s\S]*Receiving output from mini\.[\s\S]*Output verified\. Waiting for cleanup on mini\./);
    const receiptPath = /^fleet-runner: Receipt: (.+)$/m.exec(output)?.[1];
    assert.ok(receiptPath, output);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt;
    assert.equal(receipt.remote.lockReleased, true);
    assert.equal(receipt.project, 'stable-project');
    assert.equal(receipt.artifacts.length, 1);
    assert.equal(readFileSync(join(receiptPath, '..', 'artifacts/report.txt'), 'utf8'), 'result\nfinalized\n');
    assert.deepEqual((await f.call('GET', '/v1/projects')).body['projects'], []);
  } finally { await f.close(); }
});

test('recover waits for the original collection and finds the returned receipt across stores', { timeout: 30_000 }, async () => {
  class CleanupGateTransport extends AdmissionTransport {
    override start(command: string) {
      if (command.includes('fleet-runner-supervisor')) {
        // Hold the exact post-ACK window. The test releases the worker before shutting down.
        const cleanup = 'fr_clean_job_scratch "$JOB_DIR" || CLEANUP_FAILED=1';
        assert.ok(command.includes(cleanup));
        command = command.replace(cleanup,
          ': > "$HOME/cleanup-started"; while [ ! -e "$HOME/finish-cleanup" ]; do sleep 0.1; done; ' + cleanup);
      }
      return super.start(command);
    }
  }
  const f = await startServiceFixture({ transportFor: (_machine, home) => new CleanupGateTransport(home), execute: runProfile });
  try {
    const revision = (await f.call('GET', '/v1/config')).body['revision'];
    f.reports.set('Mac-Mini', report('worker'));
    assert.equal((await f.call('POST', '/v1/machines', { revision, id: 'mini', target: 'Mac-Mini', limits: {
      minFreeDiskGiB: 0, minAvailableMemoryGiB: 0, memoryPressure: 'report-only', heavyProcessAction: 'warn',
    } })).status, 200);
    const source = join(f.root, 'source-tree');
    const results = join(f.root, 'custom.noindex');
    mkdirSync(results);
    writeFiles(source, { 'source/run.sh': 'echo tests 1; echo result > report.txt', 'source/clean.sh': 'true', 'fixtures/input': 'fixture' });
    const full = manifest();
    full.profiles.check.sourceTransfer = 'tar';
    const submitted = await f.call('POST', '/v1/submit', { cwd: f.root, owner: 'collection-fixture',
      runsDirectory: results, request: { source, manifest: full, profile: 'check' } });
    assert.equal(submitted.status, 202, submitted.text);
    const job = '/v1/operations/' + String(submitted.body['operationId']);
    assert.equal(await waitUntil(() => existsSync(join(f.root, 'cleanup-started')), 10_000), true);
    const jobId = f.executed[0]?.jobId;
    assert.ok(jobId);
    const pending = (await f.call('GET', job)).body;
    assert.equal(pending['status'], 'running');
    assert.match(String(pending['output']), /Output verified\. Waiting for cleanup on mini\./);
    assert.equal(existsSync(join(results, jobId, 'receipt.json')), false);
    const recover = async (id: string) => {
      const started = await f.call('POST', '/v1/command', { cwd: f.root, owner: 'recovery-fixture', argv: ['recover', id, '--machine', 'mini'] });
      assert.equal(started.status, 202, started.text);
      const path = '/v1/operations/' + String(started.body['operationId']);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const state = (await f.call('GET', path)).body;
        if (state['status'] === 'complete') return state;
        await new Promise<void>((done) => setTimeout(done, 20));
      }
      assert.fail('Recovery did not finish.');
    };
    const racing = await recover(jobId);
    assert.equal(racing['exitCode'], 4);
    assert.match(String(racing['output']), /still in progress/);
    writeFileSync(join(f.root, 'finish-cleanup'), '');
    assert.equal(await waitUntil(() => existsSync(join(results, jobId, 'receipt.json')), 10_000), true);
    const complete = await recover(jobId);
    assert.equal(complete['exitCode'], 0, JSON.stringify(complete));
    assert.match(String(complete['output']), /already returned verified output/);
    assert.ok(String(complete['output']).includes(join(results, jobId, 'receipt.json')));
    assert.equal((await recover('missing-run'))['exitCode'], 8);
  } finally {
    writeFileSync(join(f.root, 'finish-cleanup'), '');
    await f.close();
  }
});
