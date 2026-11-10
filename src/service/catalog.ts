// Registered projects and finished-run history for apps.
//
// Projects are read from their registrations and live manifests on each call,
// exactly as the CLI does. Finished runs come from durable receipts. Clients may
// choose another run store per request, so the coordinator also keeps a small
// bounded index of each managed receipt's location; history therefore covers
// every store it ran into. The index retains only pointers and bounded summary
// measurements; a missing or pruned receipt is reported as unavailable.

import { existsSync, readFileSync, renameSync, writeFileSync, promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { describeSuccess } from '../cli/projectCommands.ts';
import { usageError } from '../errors.ts';
import { currentRunsDirectory, ensurePrivateDir, type StatePaths } from '../paths.ts';
import { listRegistrations, loadMachines, loadProject, type LoadedProject } from '../registry.ts';
import { classifyRun, isRunAbort, listReceipts, readLogTail, type Receipt, type RunAbort } from '../run/receipt.ts';
import { getProfile, makeJobId, planRun, type RunResult } from '../run/runJob.ts';
import { findMachine } from '../schema/machines.ts';
import { profileWorkload } from '../run/capacity.ts';
import type { Profile } from '../schema/manifest.ts';
import { IDENTIFIER_HINT, IDENTIFIER_PATTERN, Reader } from '../schema/validate.ts';
import { notFound } from './apiError.ts';

const JOB_ID = /^[a-z0-9-]{1,200}$/;
const RUN_INDEX = 'run-index.json';
const INDEX_LIMIT = 500;
const LOG_NAME = /^[A-Za-z0-9._-]{1,100}$/;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function profileView(profile: Profile): Record<string, unknown> {
  return {
    name: profile.name,
    kind: profile.kind,
    workload: profileWorkload(profile),
    description: profile.description,
    blocked: profile.blocked ?? null,
    command: profile.argv,
    prepare: profile.prepare,
    timeoutMinutes: profile.timeoutMinutes,
    tools: profile.requires.tools,
    guiSession: profile.requires.guiSession,
    machineEnv: profile.requires.machineEnv,
    artifacts: profile.artifacts,
    allowExtraArgs: profile.allowExtraArgs,
    success: describeSuccess(profile),
  };
}

export function projectsView(paths: StatePaths): Record<string, unknown> {
  let entries;
  try { entries = listRegistrations(paths); }
  catch (error) { return { projects: [], error: message(error) }; }
  return {
    projects: entries.map((entry) => {
      const base = { id: entry.id, manifestPath: entry.manifestPath, sourceRoot: entry.sourceRoot, registeredAt: entry.registeredAt };
      try {
        const { manifest } = loadProject(paths, entry.id);
        return {
          ...base,
          description: manifest.description ?? null,
          defaultMachine: manifest.defaultMachine ?? null,
          sends: manifest.sync.include,
          profiles: Object.values(manifest.profiles).map(profileView),
          localOnly: manifest.localOnly,
        };
      } catch (error) {
        return { ...base, description: null, defaultMachine: null, sends: [], profiles: [], localOnly: [], error: message(error) };
      }
    }),
  };
}

/** Reads the source as a run would and reports what it would send. Never contacts a worker. */
export async function planView(paths: StatePaths, projectId: string, value: unknown, inline?: LoadedProject): Promise<Record<string, unknown>> {
  const reader = new Reader('plan request');
  const input = reader.object(value, ['profile', 'machine']);
  const profileName = reader.child('profile').string(input['profile'], { pattern: IDENTIFIER_PATTERN, patternHint: IDENTIFIER_HINT });
  const project = inline ?? loadProject(paths, projectId);
  const profile = getProfile(project, profileName);
  const registry = loadMachines(paths);
  const requested = reader.child('machine').optionalString(input['machine']) ?? project.manifest.defaultMachine ?? registry.defaultMachine;
  const machine = requested === undefined ? registry.machines[0] : findMachine(registry, requested);
  if (!machine) throw usageError(requested === undefined ? 'No workers yet. Add one before planning a run.' : `Unknown worker "${requested}".`);
  const { plan, git } = await planRun({ project, profileName, machine, sourceRoot: project.entry.sourceRoot, extraArgs: [] }, makeJobId(project.manifest.id, profile.name, new Date()));
  return {
    project: project.manifest.id,
    profile: profile.name,
    machine: machine.id,
    source: { root: plan.root, files: plan.fileCount, symlinks: plan.symlinkCount, bytes: plan.totalBytes, digest: plan.digest, git },
    skipped: plan.skipped.slice(0, 20).map((entry) => ({ path: entry.relativePath, detail: entry.detail })),
    skippedCount: plan.skipped.length,
    unmatchedIncludes: plan.unmatchedIncludes,
    command: profile.argv,
    prepare: profile.prepare,
    timeoutMinutes: profile.timeoutMinutes,
    success: describeSuccess(profile),
    artifacts: profile.artifacts,
  };
}

export interface RunIndexEntry {
  readonly resources?: Receipt['resources'];
  readonly placement?: Receipt['placement'];
  readonly jobSeconds?: Receipt['timing']['jobSeconds'];
  readonly sourceDigest?: Receipt['source']['digest'];
  readonly jobId: string;
  readonly receiptPath: string;
  readonly project: string;
  readonly profile: string;
  readonly outcome: string;
  /** As in Receipt: always written now; absent from entries older than 'aborted'. */
  readonly abort?: RunAbort | null;
  readonly summary: string;
  readonly machineId: string;
  readonly finishedAt: string;
  readonly operationId?: string;
  readonly owner?: string;
}

function isIndexEntry(value: unknown): value is RunIndexEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  if (!['jobId', 'receiptPath', 'project', 'profile', 'outcome', 'summary', 'machineId', 'finishedAt'].every((key) => typeof entry[key] === 'string')) return false;
  if (entry['abort'] !== undefined && entry['abort'] !== null && !isRunAbort(entry['abort'])) return false;
  const jobId = entry['jobId'] as string, receiptPath = entry['receiptPath'] as string;
  return JOB_ID.test(jobId) && isAbsolute(receiptPath) && basename(receiptPath) === 'receipt.json' && basename(dirname(receiptPath)) === jobId;
}

function readIndex(paths: StatePaths): RunIndexEntry[] {
  const file = join(paths.home, RUN_INDEX);
  if (!existsSync(file)) return [];
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || (value as { schemaVersion?: unknown }).schemaVersion !== 1) return [];
    const runs = (value as { runs?: unknown }).runs;
    return Array.isArray(runs) ? runs.filter(isIndexEntry) : [];
  } catch {
    // A damaged pointer list only shortens history; receipts stay authoritative.
    return [];
  }
}

/** Records where a managed run's receipt lives. Best effort: never changes the run's result. */
export function recordRun(paths: StatePaths, result: RunResult, context: { readonly operationId: string; readonly owner: string }): void {
  const { receipt } = result;
  const entry: RunIndexEntry = {
    jobId: receipt.jobId, receiptPath: result.receiptPath, project: receipt.project, profile: receipt.profile,
    outcome: receipt.outcome, abort: receipt.abort ?? null, summary: receipt.summary, machineId: receipt.machine.id, finishedAt: receipt.timing.finishedAt,
    operationId: context.operationId, owner: context.owner,
    jobSeconds: receipt.timing.jobSeconds, sourceDigest: receipt.source.digest,
    ...(receipt.resources === undefined ? {} : { resources: receipt.resources }),
    ...(receipt.placement === undefined ? {} : { placement: receipt.placement }),
  };
  if (!isIndexEntry(entry)) return;
  const runs = [entry, ...readIndex(paths).filter((existing) => existing.jobId !== entry.jobId)].slice(0, INDEX_LIMIT);
  ensurePrivateDir(paths.home);
  const file = join(paths.home, RUN_INDEX);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, runs }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

async function readReceiptFile(path: string): Promise<Receipt | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || (value as { schemaVersion?: unknown }).schemaVersion !== 1) return undefined;
    const receipt = value as Receipt;
    return typeof receipt.jobId === 'string' && JOB_ID.test(receipt.jobId) ? receipt : undefined;
  } catch {
    return undefined;
  }
}

// `outcome` here is the canonical classification, so every client shows old and
// new history alike; the raw receipt in runDetailView keeps what was recorded.
function summary(receipt: Receipt, directory: string, entry?: RunIndexEntry): Record<string, unknown> {
  const classified = classifyRun(receipt);
  return {
    jobId: receipt.jobId,
    project: receipt.project,
    profile: receipt.profile,
    profileKind: receipt.profileKind ?? null,
    outcome: classified.outcome,
    abort: classified.abort ?? null,
    summary: receipt.summary,
    machineId: receipt.machine?.id ?? entry?.machineId ?? null,
    requestedAt: receipt.timing?.requestedAt ?? null,
    finishedAt: receipt.timing?.finishedAt ?? entry?.finishedAt ?? null,
    jobSeconds: receipt.timing?.jobSeconds ?? null,
    totalSeconds: receipt.timing?.totalSeconds ?? null,
    testCount: receipt.success?.testCount ?? null,
    passed: receipt.success?.passed ?? null,
    artifacts: receipt.artifacts?.length ?? 0,
    missingArtifacts: receipt.missingArtifacts?.length ?? 0,
    owner: entry?.owner ?? null,
    operationId: entry?.operationId ?? null,
    resources: receipt.resources ?? null,
    placement: receipt.placement ?? null,
    sourceDigest: receipt.source?.digest ?? null,
    available: true,
    directory,
  };
}

function unavailable(entry: RunIndexEntry): Record<string, unknown> {
  const classified = classifyRun(entry, { prunedIndex: true });
  return {
    jobId: entry.jobId, project: entry.project, profile: entry.profile, profileKind: null, outcome: classified.outcome, abort: classified.abort ?? null, summary: entry.summary,
    machineId: entry.machineId, requestedAt: null, finishedAt: entry.finishedAt, jobSeconds: entry.jobSeconds ?? null, totalSeconds: null, testCount: null,
    passed: null, artifacts: null, missingArtifacts: null, owner: entry.owner ?? null, operationId: entry.operationId ?? null,
    resources: entry.resources ?? null, placement: entry.placement ?? null,
    sourceDigest: entry.sourceDigest ?? null,
    available: false, directory: dirname(entry.receiptPath),
  };
}

export async function runsView(paths: StatePaths, query: { readonly limit: number; readonly project?: string }): Promise<Record<string, unknown>> {
  type Candidate = { jobId: string; finishedAt: string; project: string; load: () => Promise<Record<string, unknown>> | Record<string, unknown> };
  const candidates = new Map<string, Candidate>();
  for (const entry of readIndex(paths)) {
    if (candidates.has(entry.jobId)) continue;
    candidates.set(entry.jobId, { jobId: entry.jobId, finishedAt: entry.finishedAt, project: entry.project, load: async () => {
      const receipt = await readReceiptFile(entry.receiptPath);
      return receipt ? summary(receipt, dirname(entry.receiptPath), entry) : unavailable(entry);
    } });
  }
  // Changing the default results folder must not hide older local receipts.
  const runsDirectory = currentRunsDirectory(paths);
  const indexed = new Set(candidates.keys());
  for (const root of new Set([runsDirectory, join(paths.home, 'runs.noindex')])) {
    for (const receipt of await listReceipts({ ...paths, runsDir: root }, indexed)) {
      if (candidates.has(receipt.jobId) || !JOB_ID.test(receipt.jobId)) continue;
      const directory = join(root, receipt.jobId);
      candidates.set(receipt.jobId, { jobId: receipt.jobId, finishedAt: receipt.timing?.finishedAt ?? '', project: receipt.project, load: () => summary(receipt, directory) });
    }
  }
  const selected = [...candidates.values()]
    .filter((candidate) => query.project === undefined || candidate.project === query.project)
    .sort((left, right) => right.finishedAt.localeCompare(left.finishedAt))
    .slice(0, query.limit);
  // Load only the requested receipt rows, without flooding the shared
  // filesystem thread pool with a whole history page at once.
  const runs = [];
  for (const candidate of selected) runs.push(await candidate.load());
  return { runs, runsDirectory };
}

export async function runDetailView(paths: StatePaths, jobId: string, tailBytes: number): Promise<Record<string, unknown>> {
  if (!JOB_ID.test(jobId)) throw usageError(`"${jobId}" is not a job id.`);
  const entry = readIndex(paths).find((candidate) => candidate.jobId === jobId);
  let directory = entry ? dirname(entry.receiptPath) : join(currentRunsDirectory(paths), jobId);
  let receipt = await readReceiptFile(join(directory, 'receipt.json'));
  if (!receipt && !entry) {
    const legacyDirectory = join(paths.home, 'runs.noindex', jobId);
    if (legacyDirectory !== directory) {
      directory = legacyDirectory;
      receipt = await readReceiptFile(join(directory, 'receipt.json'));
    }
  }
  if (!receipt) {
    if (!entry) throw notFound(`No receipt for ${jobId}.`);
    return { jobId, available: false, directory, run: unavailable(entry) };
  }
  const logName = (name: unknown, fallback: string): string => (typeof name === 'string' && LOG_NAME.test(name) ? name : fallback);
  return {
    jobId,
    available: true,
    directory,
    run: summary(receipt, directory, entry),
    receipt,
    logs: {
      stdout: await readLogTail(join(directory, logName(receipt.logs?.stdout, 'stdout.log')), tailBytes),
      stderr: await readLogTail(join(directory, logName(receipt.logs?.stderr, 'stderr.log')), tailBytes),
    },
  };
}
