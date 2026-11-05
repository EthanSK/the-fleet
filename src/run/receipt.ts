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

import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { usageError } from '../errors.ts';
import { ensurePrivateDir, type StatePaths } from '../paths.ts';
import type { GitState } from '../snapshot/gitState.ts';
import type { ProfileKind } from '../schema/manifest.ts';
import type { SuccessCheck } from './success.ts';
import type { RsyncStatistics } from './rsyncTransfer.ts';

export const RUN_MARKER = '.fleet-run';
export const SOURCE_STAGE_OWNER = '.source-stage-owner.json';
const KEEP_LOCAL_RUNS = 50;

export type RunOutcomeKind = 'passed' | 'failed' | 'timed-out' | 'cancelled' | 'refused' | 'error';

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

export function createRunDirectory(paths: StatePaths, jobId: string): string {
  ensurePrivateDir(paths.runsDir);
  const directory = join(paths.runsDir, jobId);
  ensurePrivateDir(directory);
  writeFileSync(join(directory, RUN_MARKER), '');
  return directory;
}

/** Reclaim only disposable staging whose recorded local processes are gone. */
export function pruneAbandonedSourceStages(paths: StatePaths): void {
  if (!existsSync(paths.runsDir)) return;
  for (const name of readdirSync(paths.runsDir)) {
    if (!/^[a-z0-9-]+$/.test(name)) continue;
    const directory = join(paths.runsDir, name);
    const ownerPath = join(directory, SOURCE_STAGE_OWNER);
    const sourcePath = join(directory, 'source.noindex');
    try {
      if (!lstatSync(directory).isDirectory() || !lstatSync(join(directory, RUN_MARKER)).isFile() || !lstatSync(ownerPath).isFile()) continue;
      const owner: unknown = JSON.parse(readFileSync(ownerPath, 'utf8'));
      if (typeof owner !== 'object' || owner === null || !('pids' in owner) || !Array.isArray(owner.pids) || owner.pids.length === 0) continue;
      let abandoned = true;
      for (const pid of owner.pids) {
        if (!Number.isSafeInteger(pid) || pid < 1) { abandoned = false; break; }
        try { process.kill(pid, 0); abandoned = false; break; }
        catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') { abandoned = false; break; }
        }
      }
      if (!abandoned) continue;
      if (existsSync(sourcePath)) {
        if (!lstatSync(sourcePath).isDirectory()) continue;
        rmSync(sourcePath, { recursive: true });
      }
      rmSync(ownerPath);
    } catch { /* Unknown state is kept, never guessed abandoned. */ }
  }
}

export function writeReceipt(runDirectory: string, receipt: Receipt): string {
  const path = join(runDirectory, 'receipt.json');
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export function readReceipt(paths: StatePaths, jobId: string): Receipt {
  if (!/^[a-z0-9-]+$/.test(jobId)) throw usageError(`"${jobId}" is not a job id.`);
  const path = join(paths.runsDir, jobId, 'receipt.json');
  if (!existsSync(path)) throw usageError(`No receipt for ${jobId}.`);
  return JSON.parse(readFileSync(path, 'utf8')) as Receipt;
}

/** Newest first. Unreadable receipts are skipped rather than failing the listing. */
export function listReceipts(paths: StatePaths): Receipt[] {
  if (!existsSync(paths.runsDir)) return [];
  const receipts: Receipt[] = [];
  for (const name of readdirSync(paths.runsDir).sort().reverse()) {
    const path = join(paths.runsDir, name, 'receipt.json');
    if (!existsSync(path)) continue;
    try {
      receipts.push(JSON.parse(readFileSync(path, 'utf8')) as Receipt);
    } catch {
      // A partially written receipt from an interrupted run.
    }
  }
  return receipts;
}

export function pruneRuns(paths: StatePaths, keepJobId: string): void {
  if (!existsSync(paths.runsDir)) return;
  const finished = readdirSync(paths.runsDir)
    .filter((name) => name !== keepJobId && /^[a-z0-9-]+$/.test(name))
    .map((name) => join(paths.runsDir, name))
    .filter((directory) => existsSync(join(directory, RUN_MARKER)) && existsSync(join(directory, 'receipt.json')))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  for (const directory of finished.slice(KEEP_LOCAL_RUNS)) rmSync(directory, { recursive: true, force: true });
}
