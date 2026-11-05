// Run outcome classification: what each recorded result means, how history
// written before the 'aborted' outcome is shown, and that genuine errors keep
// precedence. Receipts are fixtures modelled on real cases with app-specific
// names removed; the history API and index are the real ones.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyRun, outcomeForExitCode, type Receipt } from '../src/run/receipt.ts';
import { recordRun } from '../src/service/catalog.ts';
import { startServiceFixture, writeRun } from './helpers/serviceFixture.ts';

const CHANGED_PATH = 'src/services/status.service.ts';
const CHANGED = `${CHANGED_PATH} changed after planning. Run again once edits settle.`;

/** A source-change stop as earlier versions recorded it: outcome error, exit 2, no `abort` key. */
function legacySourceChangeReceipt(overrides: { remote?: Partial<Receipt['remote']>; timing?: Partial<Receipt['timing']>; cliExitCode?: number; summary?: string; jobId?: string } = {}): Receipt {
  const finishedAt = '2026-11-05T15:12:40.000Z';
  return {
    schemaVersion: 1, jobId: overrides.jobId ?? '20261105-151102-example-job-a1b2c3', project: 'example', profile: 'job', profileKind: 'test',
    outcome: 'error', cliExitCode: overrides.cliExitCode ?? 2, summary: overrides.summary ?? CHANGED,
    machine: { id: 'mini', transport: 'test' },
    source: { root: '/tmp/source', digest: 'b'.repeat(64), files: 3, symlinks: 0, bytes: 30, git: null, manifest: 'source-manifest.tsv' },
    command: { argv: ['npm', 'test'], extraArgs: [], prepare: [], cwd: '.', envNames: [], timeoutSeconds: 600, script: 'command.sh' },
    timing: { requestedAt: '2026-11-05T15:11:02.000Z', remoteStartedAt: null, remoteEndedAt: finishedAt, finishedAt, jobSeconds: null, totalSeconds: 98, ...overrides.timing },
    remote: { admission: 'admitted', reason: 'aborted', exitCode: null, stragglersStopped: false, processesRemaining: false, lockReleased: true, notes: [], ...overrides.remote },
    success: { passed: false, testCount: null, checks: [{ name: 'exit status', passed: false, detail: 'aborted' }] },
    artifacts: [], missingArtifacts: [], logs: { stdout: 'stdout.log', stderr: 'stderr.log' },
  };
}

test('a legacy source-change error is shown as aborted only with complete evidence', () => {
  assert.deepEqual(classifyRun(legacySourceChangeReceipt()), { outcome: 'aborted', abort: { reason: 'source-changed', path: CHANGED_PATH } });
  // Any missing piece of evidence keeps the recorded error.
  for (const receipt of [
    legacySourceChangeReceipt({ remote: { lockReleased: false } }),
    legacySourceChangeReceipt({ remote: { processesRemaining: true } }),
    legacySourceChangeReceipt({ remote: { reason: 'upload-timeout' } }),
    legacySourceChangeReceipt({ remote: { exitCode: 0 } }),
    legacySourceChangeReceipt({ timing: { remoteStartedAt: '2026-11-05T15:11:30.000Z' } }),
    legacySourceChangeReceipt({ cliExitCode: 5 }),
    legacySourceChangeReceipt({ summary: `${CHANGED} Lock release not confirmed; check: fleet-runner status` }),
    legacySourceChangeReceipt({ summary: 'Upload failed.' }),
  ]) assert.deepEqual(classifyRun(receipt), { outcome: 'error' }, JSON.stringify(receipt));
  // A pruned receipt's index entry keeps only its summary. Unconfirmed cleanup
  // always appended a lock note, so the bare message proves cleanup finished.
  assert.equal(classifyRun({ outcome: 'error', summary: CHANGED }, { prunedIndex: true }).outcome, 'aborted');
  assert.equal(classifyRun({ outcome: 'error', summary: CHANGED }).outcome, 'error', 'missing receipt evidence is not a pruned index');
  for (const field of ['remote', 'timing', 'cliExitCode'] as const) {
    const incomplete = { ...legacySourceChangeReceipt() } as Partial<Receipt>;
    delete incomplete[field];
    assert.equal(classifyRun(incomplete as Receipt).outcome, 'error', `missing ${field} keeps a full receipt conservative`);
  }
  assert.equal(classifyRun({ outcome: 'error', summary: `${CHANGED} Lock kept: job processes are still running.` }).outcome, 'error');
  // Records written since 'aborted' existed are already canonical and never reinterpreted.
  assert.deepEqual(classifyRun({ ...legacySourceChangeReceipt(), abort: null }), { outcome: 'error' });
});

test('job failures stay failed while output verification and unknown endings are errors', () => {
  // Real cases: an XCTest assertion and TypeScript compile errors both exited 1.
  assert.deepEqual(classifyRun({ outcome: 'failed', summary: 'Failed on m1max: 1 test, exit 1 (18s)', cliExitCode: 1 }), { outcome: 'failed' });
  assert.deepEqual(classifyRun({ outcome: 'failed', summary: 'Failed on m1max: exit 1 (2m 18s)', cliExitCode: 1 }), { outcome: 'failed' });
  // Earlier versions recorded output verification failure (exit 8) as failed.
  assert.deepEqual(classifyRun({ outcome: 'failed', summary: 'Artifacts from mini failed verification.', cliExitCode: 8 }), { outcome: 'error' });
  assert.deepEqual(classifyRun({ outcome: 'failed', summary: 'Artifacts from mini failed verification. Lock release not confirmed; check: fleet-runner status' }), { outcome: 'error' });
  for (const outcome of ['passed', 'timed-out', 'cancelled', 'refused', 'error'] as const) {
    assert.deepEqual(classifyRun({ outcome, summary: 'Recorded summary' }), { outcome });
  }
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 42, undefined].map((code) => outcomeForExitCode(code)),
    ['passed', 'failed', 'error', 'refused', 'refused', 'error', 'timed-out', 'cancelled', 'error', 'error', 'error']);
});

test('history shows legacy source-change stops as aborted while receipts keep what they recorded', async () => {
  const f = await startServiceFixture();
  try {
    const legacy = legacySourceChangeReceipt();
    const directory = join(f.paths.runsDir, legacy.jobId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, '.fleet-run'), '');
    writeFileSync(join(directory, 'receipt.json'), JSON.stringify(legacy));
    const unconfirmed = legacySourceChangeReceipt({ jobId: '20261105-151103-example-job-d4e5f6', remote: { lockReleased: false } });
    mkdirSync(join(f.paths.runsDir, unconfirmed.jobId));
    writeFileSync(join(f.paths.runsDir, unconfirmed.jobId, 'receipt.json'), JSON.stringify(unconfirmed));
    // A failed attempt stays failed after a later run of the same profile passes.
    writeRun(f.paths.runsDir, '20261105-151100-model-bar-request-aaaaaa', { outcome: 'failed', project: 'model-bar', profile: 'request', finishedAt: '2026-11-05T15:11:00.000Z' });
    writeRun(f.paths.runsDir, '20261105-152000-model-bar-request-bbbbbb', { outcome: 'passed', project: 'model-bar', profile: 'request', finishedAt: '2026-11-05T15:20:00.000Z' });

    const runs = (await f.call('GET', '/v1/runs')).body['runs'] as Record<string, unknown>[];
    const byJob = new Map(runs.map((run) => [run['jobId'], run]));
    assert.equal(byJob.get(legacy.jobId)?.['outcome'], 'aborted');
    assert.deepEqual(byJob.get(legacy.jobId)?.['abort'], { reason: 'source-changed', path: CHANGED_PATH });
    assert.equal(byJob.get(unconfirmed.jobId)?.['outcome'], 'error', 'unconfirmed cleanup is never downgraded');
    assert.equal(byJob.get('20261105-151100-model-bar-request-aaaaaa')?.['outcome'], 'failed');
    assert.equal(byJob.get('20261105-152000-model-bar-request-bbbbbb')?.['outcome'], 'passed');

    const detail = await f.call('GET', `/v1/runs/${legacy.jobId}`);
    assert.equal((detail.body['run'] as Record<string, unknown>)['outcome'], 'aborted');
    assert.equal((detail.body['receipt'] as Record<string, unknown>)['outcome'], 'error', 'the receipt keeps its recorded outcome');
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8')), legacy, 'reading history never rewrites a receipt');
  } finally { await f.close(); }
});

test('pruned history entries keep their typed abort, and legacy entries need exact evidence', async () => {
  const f = await startServiceFixture();
  try {
    const aborted = writeRun(f.paths.runsDir, '20261105-160000-example-test-aaaaaa', { outcome: 'aborted', abort: { reason: 'source-changed', path: 'package.json' } });
    recordRun(f.paths, aborted, { operationId: 'fixture', owner: 'history-test' });
    rmSync(join(f.paths.runsDir, aborted.receipt.jobId), { recursive: true });
    const entries = JSON.parse(readFileSync(join(f.paths.home, 'run-index.json'), 'utf8')) as { runs: Record<string, unknown>[] };
    const entry = (jobId: string, finishedAt: string, outcome: string, summary: string, extra: Record<string, unknown> = {}) => ({
      jobId, receiptPath: join(f.paths.runsDir, jobId, 'receipt.json'), project: 'example', profile: 'test', outcome, summary,
      machineId: 'mini', finishedAt, ...extra,
    });
    entries.runs.push(
      entry('20261105-150000-example-test-legacy1', '2026-11-05T15:00:00.000Z', 'error', CHANGED),
      entry('20261105-150100-example-test-legacy2', '2026-11-05T15:01:00.000Z', 'error', `${CHANGED} Lock release not confirmed; check: fleet-runner status`),
      entry('20261105-150200-example-test-legacy3', '2026-11-05T15:02:00.000Z', 'failed', 'Artifacts from mini failed verification.'),
      entry('20261105-150300-example-test-current', '2026-11-05T15:03:00.000Z', 'error', CHANGED, { abort: null }),
    );
    writeFileSync(join(f.paths.home, 'run-index.json'), JSON.stringify(entries));

    const runs = (await f.call('GET', '/v1/runs')).body['runs'] as Record<string, unknown>[];
    const outcome = (jobId: string) => runs.find((run) => run['jobId'] === jobId);
    assert.equal(outcome(aborted.receipt.jobId)?.['available'], false);
    assert.equal(outcome(aborted.receipt.jobId)?.['outcome'], 'aborted');
    assert.deepEqual(outcome(aborted.receipt.jobId)?.['abort'], { reason: 'source-changed', path: 'package.json' });
    assert.equal(outcome('20261105-150000-example-test-legacy1')?.['outcome'], 'aborted');
    assert.equal(outcome('20261105-150100-example-test-legacy2')?.['outcome'], 'error');
    assert.equal(outcome('20261105-150200-example-test-legacy3')?.['outcome'], 'error');
    assert.equal(outcome('20261105-150300-example-test-current')?.['outcome'], 'error', 'a typed entry is never reinterpreted from its summary');
  } finally { await f.close(); }
});
