// Run receipts and the local runs.noindex folder.
//
// Every run gets runs.noindex/<job-id>/ in the private state directory with
// receipt.json, stdout.log, stderr.log, the exact source manifest that was
// sent, the generated command.sh and any verified artifacts. The receipt is
// the structured record of what ran: source digest, profile, machine, exit
// status, timing, success checks and artifact hashes.
//
// Retention is bounded: older finished run folders beyond KEEP_LOCAL_RUNS are
// removed, and only folders carrying this runner's marker file.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { EXIT_CODES, usageError } from '../errors.ts';
import type { StatePaths } from '../paths.ts';
import type { GitState } from '../snapshot/gitState.ts';
import { SOURCE_CHANGED_SUMMARY_SUFFIX } from '../snapshot/readFile.ts';
import type { ProfileKind } from '../schema/manifest.ts';
import type { SuccessCheck } from './success.ts';
import type { RsyncStatistics } from './rsyncTransfer.ts';

export const RUN_MARKER = '.fleet-run';
export const SOURCE_STAGE_OWNER = '.source-stage-owner.json';
const KEEP_LOCAL_RUNS = 50;

/**
 * One run's result. The three groups matter more than the names:
 * - Job results: `passed`, and `failed`/`timed-out` when the job itself ran and
 *   didn't succeed. A failed test is a valid result, not a Fleet problem.
 * - No verdict: `cancelled` by a caller, `aborted` by The Fleet before the job
 *   started to protect the result (source changed after planning), or
 *   `refused` by a worker at admission. Nothing ran to completion.
 * - `error`: The Fleet couldn't run, verify or clean up the job (connection,
 *   upload, output verification, unconfirmed cleanup or invalid settings).
 *   Errors should be rare, and always take precedence over a job result.
 * Apps show job failures amber, no verdict grey and errors red. Exit codes are
 * unchanged; an abort still exits 2, as it did when it was recorded as error.
 * (User-requested — 2026-11-05: "failed is good for truly failed stuff, error is
 * actually error"; protective source-change stops were filling history with
 * red Error entries.)
 */
export type RunOutcomeKind = 'passed' | 'failed' | 'timed-out' | 'cancelled' | 'aborted' | 'refused' | 'error';

/** Why The Fleet deliberately stopped a run before its job started. */
export interface RunAbort {
  readonly reason: 'source-changed';
  /** Selected path, relative to the source root, that changed after planning. */
  readonly path: string;
}

export interface Receipt {
  /** Sampled owned-process-group estimates; short-lived processes can be missed. */
  readonly resources?: { readonly sampleCount: number; readonly sampleIntervalSeconds: 5; readonly peakRssKiB: number;
    readonly peakProcessCpuPercent: number };
  readonly placement?: { readonly strategy: 'load-aware'; readonly pressureLevel?: number; readonly loadPerCpu?: number;
    readonly availableMemoryBytes?: number; readonly occupiedSlots: number };
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly project: string;
  readonly profile: string;
  readonly profileKind: ProfileKind;
  readonly outcome: RunOutcomeKind;
  /** Set only when outcome is 'aborted'. New receipts always write the key
   * (null otherwise); its absence marks a receipt from before 'aborted' existed. */
  readonly abort?: RunAbort | null;
  readonly cliExitCode: number;
  readonly summary: string;
  readonly machine: { readonly id: string; readonly transport: string; readonly host?: string; readonly fingerprint?: string };
  readonly source: {
    readonly root: string;
    readonly digest: string;
    readonly files: number;
    readonly symlinks: number;
    readonly bytes: number;
    readonly git: GitState | null;
    readonly manifest: string;
    readonly transfer?: RsyncStatistics;
  };
  readonly command: {
    readonly argv: readonly string[];
    readonly extraArgs: readonly string[];
    readonly prepare: readonly (readonly string[])[];
    readonly cwd: string;
    readonly envNames: readonly string[];
    readonly timeoutSeconds: number;
    readonly script: string;
  };
  readonly timing: {
    readonly requestedAt: string;
    readonly remoteStartedAt: string | null;
    readonly remoteEndedAt: string | null;
    readonly finishedAt: string;
    readonly jobSeconds: number | null;
    readonly totalSeconds: number;
  };
  readonly remote: {
    readonly admission?: 'refused' | 'admitted' | 'uncertain';
    readonly reason: string | null;
    readonly exitCode: number | null;
    readonly stragglersStopped: boolean;
    readonly processesRemaining: boolean;
    readonly lockReleased: boolean;
    readonly notes: readonly string[];
  };
  readonly success: { readonly passed: boolean; readonly testCount: number | null; readonly checks: readonly SuccessCheck[] };
  readonly artifacts: readonly { readonly path: string; readonly sha256: string; readonly bytes: number }[];
  readonly missingArtifacts: readonly string[];
  readonly logs: { readonly stdout: string; readonly stderr: string };
}

/** What a receipt records about its result, or what the history index keeps
 * once retention has pruned the receipt itself. */
export interface RecordedRunResult<Outcome extends string = string> {
  readonly outcome: Outcome;
  readonly summary: string;
  readonly abort?: RunAbort | null | undefined;
  // Receipt-only evidence. Absent from index entries, and parsed receipts from
  // older versions may lack some of it.
  readonly cliExitCode?: number | undefined;
  readonly remote?: Partial<Pick<Receipt['remote'], 'reason' | 'exitCode' | 'lockReleased' | 'processesRemaining'>> | undefined;
  readonly timing?: Partial<Pick<Receipt['timing'], 'remoteStartedAt'>> | undefined;
}

export interface RunClassification<Outcome extends string = RunOutcomeKind> {
  readonly outcome: Outcome | 'aborted' | 'error';
  readonly abort?: RunAbort;
}

/**
 * The one canonical outcome of a recorded run, shared by run history, the
 * operation API and the CLI. Records written since 'aborted' existed already
 * hold it and pass through unchanged. Older records are only reclassified on
 * exact evidence; anything uncertain keeps its recorded outcome. The receipt
 * file is never rewritten, so its original outcome remains available.
 */
export function classifyRun<Outcome extends string>(record: RecordedRunResult<Outcome>, options: { readonly prunedIndex?: boolean } = {}): RunClassification<Outcome> {
  if (record.outcome === 'aborted') return isRunAbort(record.abort) ? { outcome: record.outcome, abort: record.abort } : { outcome: record.outcome };
  if (record.abort !== undefined) return { outcome: record.outcome };
  const abort = legacySourceChange(record, options.prunedIndex === true);
  if (abort) return { outcome: 'aborted', abort };
  // Earlier versions recorded output verification failure (exit 8) as
  // `failed`. It is a Fleet verification error, never a job result, so it
  // must not turn amber under the new colours. Upgrading severity needs less
  // proof than downgrading it: the summary alone suffices for index entries.
  if (record.outcome === 'failed' && (record.cliExitCode === EXIT_CODES.artifactVerification
    || (record.cliExitCode === undefined && typeof record.summary === 'string' && /^Artifacts from .+ failed verification\./.test(record.summary)))) {
    return { outcome: 'error' };
  }
  return { outcome: record.outcome };
}

/**
 * Recognises a source-change stop recorded as `error` before 'aborted' existed
 * (it exited 2 with the SourceChangedError message as its summary). The
 * summary must end exactly with that message: runJob appended a lock note
 * whenever cleanup was unconfirmed, so the bare message also shows the lock was
 * released with no job processes left. A full receipt must also prove the job
 * never started and its supervisor recorded the abort.
 */
function legacySourceChange(record: RecordedRunResult, prunedIndex: boolean): RunAbort | undefined {
  if (record.outcome !== 'error' || typeof record.summary !== 'string' || !record.summary.endsWith(SOURCE_CHANGED_SUMMARY_SUFFIX)) return undefined;
  const path = record.summary.slice(0, -SOURCE_CHANGED_SUMMARY_SUFFIX.length);
  if (path === '' || path.includes('\n')) return undefined;
  const { cliExitCode, remote, timing } = record;
  // Only the catalog's pruned index deliberately lacks these fields. A
  // damaged full receipt must not become safer because its evidence vanished.
  if (!prunedIndex && (cliExitCode !== EXIT_CODES.usage || remote === undefined || timing === undefined)) return undefined;
  if (cliExitCode !== undefined && cliExitCode !== EXIT_CODES.usage) return undefined;
  if (remote !== undefined && (remote.reason !== 'aborted' || remote.exitCode !== null || remote.lockReleased !== true || remote.processesRemaining !== false)) return undefined;
  if (timing !== undefined && timing.remoteStartedAt !== null) return undefined;
  return { reason: 'source-changed', path };
}

export function isRunAbort(value: unknown): value is RunAbort {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate['reason'] === 'source-changed' && typeof candidate['path'] === 'string' && candidate['path'] !== '';
}

/**
 * The outcome for an operation that has no deciding receipt, such as a worker
 * refusal before admission or an invalid request. Exit 2 can also be a
 * source-change abort, but only a receipt proves that; without one it stays
 * an error, as does exit 8 (output verification).
 */
export function outcomeForExitCode(exitCode: number | undefined): RunOutcomeKind {
  switch (exitCode) {
    case EXIT_CODES.ok: return 'passed';
    case EXIT_CODES.jobFailed: return 'failed';
    case EXIT_CODES.timedOut: return 'timed-out';
    case EXIT_CODES.cancelled: return 'cancelled';
    case EXIT_CODES.machineCheckRefused:
    case EXIT_CODES.machineBusy: return 'refused';
    case EXIT_CODES.usage:
    case EXIT_CODES.transport:
    case EXIT_CODES.artifactVerification: return 'error';
    default: return 'error';
  }
}

export async function createRunDirectory(paths: StatePaths, jobId: string): Promise<string> {
  // Configured external roots must already exist. A drive can disappear
  // after admission and must not be recreated on the controller's disk.
  if (paths.runsDir === join(paths.home, 'runs.noindex')) {
    await fs.mkdir(paths.runsDir, { recursive: true, mode: 0o700 });
  }
  await fs.chmod(paths.runsDir, 0o700);
  const directory = join(paths.runsDir, jobId);
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(join(directory, RUN_MARKER), '');
  return directory;
}

/** Reclaim only disposable staging whose recorded local processes are gone. */
export async function pruneAbandonedSourceStages(paths: StatePaths): Promise<void> {
  const names = await fs.readdir(paths.runsDir).catch(() => []);
  for (const name of names) {
    if (!/^[a-z0-9-]+$/.test(name)) continue;
    const directory = join(paths.runsDir, name);
    const ownerPath = join(directory, SOURCE_STAGE_OWNER);
    const sourcePath = join(directory, 'source.noindex');
    try {
      if (!(await fs.lstat(directory)).isDirectory() || !(await fs.lstat(ownerPath)).isFile() || !(await fs.lstat(join(directory, RUN_MARKER))).isFile()) continue;
      const owner: unknown = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
      if (typeof owner !== 'object' || owner === null || !('pids' in owner) || !Array.isArray(owner.pids) || owner.pids.length === 0) continue;
      if ('startingRsync' in owner && owner.startingRsync !== false) continue;
      let abandoned = true;
      for (const pid of owner.pids) {
        if (!Number.isSafeInteger(pid) || pid < 1) { abandoned = false; break; }
        try { process.kill(pid, 0); abandoned = false; break; }
        catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') { abandoned = false; break; }
        }
      }
      if (!abandoned) continue;
      const source = await fs.lstat(sourcePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
      if (source) {
        if (!source.isDirectory()) continue;
        await fs.rm(sourcePath, { recursive: true, force: true });
      }
      await fs.rm(ownerPath, { force: true });
    } catch { /* Unknown state is kept, never guessed abandoned. */ }
  }
}

export async function writeReceipt(runDirectory: string, receipt: Receipt): Promise<string> {
  const path = join(runDirectory, 'receipt.json');
  // Publish the completed receipt atomically so overlapping history scans and
  // retention cannot treat a half-written run as finished.
  const temporary = `${path}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, path);
  return path;
}

export async function readReceipt(paths: StatePaths, jobId: string): Promise<Receipt> {
  if (!/^[a-z0-9-]+$/.test(jobId)) throw usageError(`"${jobId}" is not a job id.`);
  const path = join(paths.runsDir, jobId, 'receipt.json');
  const contents = await fs.readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw usageError(`No receipt for ${jobId}.`);
    throw error;
  });
  return JSON.parse(contents) as Receipt;
}

/** Newest first. Unreadable receipts are skipped rather than failing the listing. */
export async function listReceipts(paths: StatePaths, indexed?: ReadonlySet<string>): Promise<Receipt[]> {
  const names = await fs.readdir(paths.runsDir).catch(() => []);
  const receipts: Receipt[] = [];
  for (const name of names.sort().reverse()) {
    if (indexed?.has(name) || !/^[a-z0-9-]+$/.test(name)) continue;
    try {
      receipts.push(await readReceipt(paths, name));
    } catch {
      // A partially written receipt from an interrupted run.
    }
  }
  return receipts;
}

export async function pruneRuns(paths: StatePaths, keepJobId: string): Promise<void> {
  const names = await fs.readdir(paths.runsDir).catch(() => []);
  const finished: { directory: string; modified: number }[] = [];
  for (const name of names) {
    if (name === keepJobId || !/^[a-z0-9-]+$/.test(name)) continue;
    const directory = join(paths.runsDir, name);
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || !(await fs.lstat(join(directory, RUN_MARKER))).isFile()
        || !(await fs.lstat(join(directory, 'receipt.json'))).isFile()) continue;
      finished.push({ directory, modified: stat.mtimeMs });
    } catch (error) {
      // A different completion may have already pruned this run.
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
  }
  finished.sort((left, right) => right.modified - left.modified);
  for (const { directory } of finished.slice(KEEP_LOCAL_RUNS)) await fs.rm(directory, { recursive: true, force: true });
}

/** Read only the requested log tail, leaving other API requests free to run. */
export async function readLogTail(path: string, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean; present: boolean }> {
  const file = await fs.open(path, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (!file) return { text: '', bytes: 0, truncated: false, present: false };
  try {
    const { size } = await file.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await file.read(buffer, read, length - read, size - length + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    let start = 0;
    while (size > length && start < Math.min(3, read) && ((buffer[start] ?? 0) & 0xc0) === 0x80) start += 1;
    return { text: buffer.subarray(start, read).toString('utf8'), bytes: size, truncated: size > length, present: true };
  } finally {
    await file.close();
  }
}
