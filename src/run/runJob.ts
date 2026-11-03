// `fleet-runner run`: one on-demand job on one fleet machine.
//
// Order of operations, and why:
//  1. Plan the snapshot locally (read-only) and render command.sh, so config
//     mistakes fail before any remote work.
//  2. Read-only machine check. Busy, stale, low disk/memory, other heavy work
//     or missing tools refuse the run; nothing waits or retries.
//  3. Start the supervisor. It takes the machine's heavy-job lock atomically
//     and creates an isolated job folder, or answers BUSY.
//  4. Stream the snapshot into that folder over a second ssh session.
//  5. Tell the supervisor to start; forward live output; wait for RESULT.
//     The supervisor enforces the timeout remotely. This side keeps a later
//     safety deadline only to stop waiting on a silent connection.
//  6. Receive and verify declared artifacts, ACK, and wait for the lock
//     release. Evaluate the profile's success criteria and write the receipt.
// A failure never falls back to running locally.
//
// Ctrl-C: the first interrupt asks the supervisor to cancel (it stops the
// job's process group, cleans up and releases the lock); a second interrupt
// drops the connection, which the supervisor also treats as a cancel.

import { randomBytes } from 'node:crypto';
import { createWriteStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EXIT_CODES, FleetError, RunNotStartedError, usageError } from '../errors.ts';
import type { StatePaths } from '../paths.ts';
import type { LoadedProject } from '../registry.ts';
import { supervisorCommand, uploadCommand } from '../remote/remoteScripts.ts';
import { parseFields } from '../remote/supervisorStream.ts';
import type { Machine } from '../schema/machines.ts';
import type { Profile } from '../schema/manifest.ts';
import { readGitState, type GitState } from '../snapshot/gitState.ts';
import { planSnapshot, formatMiB, type SnapshotPlan } from '../snapshot/select.ts';
import { extractTarSafely, SourceChangedError, tarStream, type ExtractedFile, type TarMember } from '../snapshot/tar.ts';
import { firstLines, type Transport } from '../transport/transport.ts';
import { renderCommandScript } from './commandScript.ts';
import { JobSession, TimeoutWaitingError } from './jobSession.ts';
import { evaluatePreflight, formatDuration, type PreflightReport } from './preflight.ts';
import { createRunDirectory, pruneAbandonedSourceStages, pruneRuns, writeReceipt, type Receipt, type RunOutcomeKind } from './receipt.ts';
import { fetchPreflight } from './remoteChecks.ts';
import { evaluateSuccess, type SuccessEvaluation } from './success.ts';
import { syncSource, type RsyncStatistics } from './rsyncTransfer.ts';
import { parseArchiveDiskSpaceProblem, reportDiskSpaceProblem, type DiskSpaceProblemHandler } from './diskSpace.ts';

export interface RunIo {
  readonly stdout: Writable;
  readonly stderr: Writable;
  /** Runner status line (kept off stdout so job output stays clean). */
  readonly status: (line: string) => void;
  readonly onDiskSpaceProblem?: DiskSpaceProblemHandler;
}

/** Ctrl-C bridge from the CLI; tests trigger it directly. */
export class Interrupts {
  private listener: ((count: number) => void) | undefined;
  private count = 0;

  get requested(): boolean { return this.count > 0; }

  onInterrupt(listener: (count: number) => void): void {
    this.listener = listener;
  }

  /** Returns false when no job is listening, so the CLI can simply exit. */
  trigger(): boolean {
    if (!this.listener) return false;
    this.count += 1;
    this.listener(this.count);
    return true;
  }
}

export interface RunRequest {
  /** Preallocated by the coordinator so crash recovery retains job identity. */
  readonly jobId?: string;
  readonly paths: StatePaths;
  readonly project: LoadedProject;
  readonly profileName: string;
  readonly machine: Machine;
  readonly transport: Transport;
  readonly sourceRoot: string;
  readonly extraArgs: readonly string[];
  readonly ignoreHeavyProcesses: boolean;
  readonly io: RunIo;
  readonly interrupts?: Interrupts;
  /** Overrides for tests; production uses the defaults below. */
  readonly timing?: Partial<RunTiming>;
  /** A read-only check already made by ordered worker selection. */
  readonly preflightReport?: PreflightReport;
}

export interface RunTiming {
  readonly readyTimeoutMs: number;
  readonly safetyMarginMs: number;
  readonly finishTimeoutMs: number;
}

const DEFAULT_TIMING: RunTiming = {
  readyTimeoutMs: 60_000,
  safetyMarginMs: 120_000,
  finishTimeoutMs: 15 * 60_000,
};

export interface RunResult {
  readonly exitCode: number;
  readonly receipt: Receipt;
  readonly receiptPath: string;
  readonly admission: 'refused' | 'admitted' | 'uncertain';
}

export function getProfile(project: LoadedProject, profileName: string): Profile {
  const profile = project.manifest.profiles[profileName];
  if (!profile) {
    throw usageError(`${project.manifest.id} has no profile "${profileName}". Profiles: ${Object.keys(project.manifest.profiles).join(', ')}`);
  }
  return profile;
}

export function makeJobId(project: string, profile: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15).toLowerCase();
  return `${stamp}-${project}-${profile}-${randomBytes(3).toString('hex')}`;
}

export async function planRun(request: Pick<RunRequest, 'project' | 'profileName' | 'machine' | 'sourceRoot' | 'extraArgs'>, jobId: string): Promise<{
  profile: Profile;
  plan: SnapshotPlan;
  git: GitState | null;
  script: string;
  finalizerScript?: string;
  label: string;
}> {
  const profile = getProfile(request.project, request.profileName);
  const label = `${request.project.manifest.id}/${profile.name}`;
  if (profile.blocked !== undefined) throw usageError(`${label} is blocked: ${profile.blocked}`);
  const script = renderCommandScript({ profile, machine: request.machine, extraArgs: request.extraArgs, jobId, label });
  const sync = request.project.manifest.sync;
  const plan = await planSnapshot(request.sourceRoot, { ...sync, include: [...sync.include, ...profile.extraInputs] });
  if (plan.entries.length === 0) throw usageError(`No files selected from ${plan.root}. Check sync.include.`);
  const git = await readGitState(plan.root);
  const finalizerScript = profile.finalizer === undefined ? undefined : renderCommandScript({ profile: { ...profile, argv: profile.finalizer.argv, prepare: [], requires: { ...profile.requires, tools: [] } }, machine: request.machine, extraArgs: [], jobId, label });
  return { profile, plan, git, script, label, ...(finalizerScript === undefined ? {} : { finalizerScript }) };
}

export function uploadMembers(plan: SnapshotPlan, profile: Profile, script: string, finalizerScript?: string, machine?: Machine): TarMember[] {
  const text = (name: string, value: string, mode = 0o644): TarMember => ({ kind: 'data', name, mode, data: Buffer.from(value, 'utf8') });
  const members: TarMember[] = [
    text('meta/command.sh', script, 0o755),
    text('meta/source-manifest.tsv', plan.manifestText),
    text('meta/expected-count', `${plan.entries.length}\n`),
  ];
  if (profile.finalizer) {
    if (finalizerScript === undefined) throw usageError('Finalizer script was not planned.');
    members.push(text('meta/finalizer.sh', finalizerScript, 0o755));
    members.push(text('meta/finalizer-seconds', `${profile.finalizer.timeoutSeconds}\n`));
    members.push(text('meta/finalize.py', readFileSync(new URL('../../remote/finalize.py', import.meta.url), 'utf8')));
  }
  if (profile.artifacts.length > 0) {
    members.push(text('meta/artifacts', `${profile.artifacts.join('\n')}\n`));
    members.push(text('meta/max-artifact-kb', `${Math.round(profile.maxArtifactMiB * 1024)}\n`));
    members.push(text('meta/large_scratch.py', readFileSync(new URL('../../remote/large_scratch.py', import.meta.url), 'utf8')));
    if (machine?.largeScratch) {
      members.push(text('meta/large-scratch.json', JSON.stringify(machine.largeScratch)));
    }
  }
  if (profile.cache) members.push(text('meta/cache', `${profile.cache.name} ${Math.round(profile.cache.maxGiB * 1024 * 1024)}\n`));
  if (profile.isolatedTmp) members.push(text('meta/isolated-tmp', ''));
  for (const entry of plan.entries) members.push({ kind: 'snapshot', name: `src/${entry.relativePath}`, entry });
  return members;
}

export async function runProfile(request: RunRequest): Promise<RunResult> {
  let sessionAttempted = false;
  try {
    return await executeProfile(request, () => { sessionAttempted = true; });
  } catch (error) {
    // A neighbour's work says nothing about whether this run started. Carry
    // explicit local proof instead of requiring the entire worker to be idle.
    if (!sessionAttempted) throw new RunNotStartedError(error);
    throw error;
  }
}

// Extraction of existing runProfile execution. The new callback marks the
// session boundary before transport.start can have any remote side effects.
async function executeProfile(request: RunRequest, sessionStarting: () => void): Promise<RunResult> {
  const timing = { ...DEFAULT_TIMING, ...request.timing };
  const { machine, transport, io, paths } = request;
  const requestedAt = new Date();
  const jobId = request.jobId ?? makeJobId(request.project.manifest.id, request.profileName, requestedAt);
  const nonce = randomBytes(12).toString('hex');
  const { profile, plan, git, script, label, finalizerScript } = await planRun(request, jobId);
  if (profile.sourceTransfer === 'rsync' && !transport.startRsync) throw usageError('This transport does not support rsync.');

  io.status(`${label} on ${machine.id}: ${plan.fileCount} files${plan.symlinkCount ? ` + ${plan.symlinkCount} links` : ''}, ${formatMiB(plan.totalBytes)}, source ${plan.digest.slice(0, 12)}`);
  for (const skipped of plan.skipped.slice(0, 10)) io.status(`  not sent: ${skipped.relativePath} (${skipped.detail})`);
  if (plan.skipped.length > 10) io.status(`  not sent: ${plan.skipped.length - 10} more (see fleet-runner plan --files)`);

  // ---- machine check (read-only)
  const report = request.preflightReport ?? await fetchPreflight(transport, machine, profile.pathPrepend, [...profile.requires.tools, ...(profile.sourceTransfer === 'rsync' ? ['rsync'] : [])]);
  const decision = evaluatePreflight(report, machine, profile, { ignoreHeavyProcesses: request.ignoreHeavyProcesses, nowEpoch: Math.floor(Date.now() / 1000) });
  for (const warning of decision.warnings) io.status(`warning: ${warning.message}`);
  const firstRefusal = decision.refusals[0];
  if (firstRefusal) {
    for (const finding of decision.refusals) if (finding.kind === 'disk') {
      reportDiskSpaceProblem(io.onDiskSpaceProblem, { machineId: machine.id, phase: 'admission', message: finding.message });
    }
    const kind = firstRefusal.kind === 'busy' || firstRefusal.kind === 'stale' ? 'machineBusy' : 'machineCheckRefused';
    throw new FleetError(kind, firstRefusal.message, decision.refusals.slice(1).map((finding) => finding.message));
  }

  // ---- local run folder
  pruneAbandonedSourceStages(paths);
  const runDirectory = createRunDirectory(paths, jobId);
  writeFileSync(join(runDirectory, 'source-manifest.tsv'), plan.manifestText, { mode: 0o600 });
  writeFileSync(join(runDirectory, 'command.sh'), script, { mode: 0o600 });
  const stdoutLog = createWriteStream(join(runDirectory, 'stdout.log'), { mode: 0o600 });
  const stderrLog = createWriteStream(join(runDirectory, 'stderr.log'), { mode: 0o600 });

  const state = {
    remoteStartedEpoch: null as number | null,
    remoteEndedEpoch: null as number | null,
    reason: null as string | null,
    exitCode: null as number | null,
    stragglers: false,
    stuck: false,
    lockReleased: false,
    notes: [] as string[],
    artifacts: [] as ExtractedFile[],
    missingArtifacts: [] as string[],
    artifactError: null as FleetError | null,
    failure: null as FleetError | null,
  };

  const command = supervisorCommand(machine, { jobId, nonce, timeoutSeconds: profile.timeoutMinutes * 60, label, profile });
  sessionStarting();
  const session = new JobSession(transport, command, nonce, {
    onProtocol: (line) => {
      if (line.word !== 'DISK-SPACE') return;
      const problem = parseArchiveDiskSpaceProblem(line.rest, machine.id);
      if (problem) reportDiskSpaceProblem(io.onDiskSpaceProblem, problem);
    },
    onJobStdout: (data) => {
      io.stdout.write(data);
      stdoutLog.write(data);
    },
    onStderr: (data) => {
      io.stderr.write(data);
      stderrLog.write(data);
    },
  });
  // Arm before receiving any output: RESULT and the archive header/payload
  // may arrive in the same SSH chunk, before an awaited continuation runs.
  const artifactArchive = join(runDirectory, 'artifacts.tar.part');
  session.captureArtifactsTo(artifactArchive);

  let jobStarted = false;
  let admission: RunResult['admission'] = 'uncertain';
  let transfer: RsyncStatistics | undefined;
  let cancelRequested = false;
  request.interrupts?.onInterrupt((count) => {
    if (count === 1) {
      cancelRequested = true;
      io.status(`Cancelling on ${machine.id}. Press Ctrl-C again to disconnect (the job is still stopped remotely).`);
      session.send(jobStarted ? 'CANCEL' : 'ABORT');
    } else {
      session.kill();
    }
  });

  try {
    // ---- lock + job folder
    const ready = await session.waitFor(['READY', 'BUSY', 'ERROR'], timing.readyTimeoutMs).catch((error: unknown) => {
      throw error instanceof TimeoutWaitingError ? new FleetError('transport', `${machine.id} didn't start the job within ${timing.readyTimeoutMs / 1000}s.`) : error;
    });
    if (ready.word === 'BUSY') {
      admission = 'refused';
      throw new FleetError('machineBusy', `${machine.id} is busy (${ready.rest}). Nothing was started.`);
    }
    if (ready.word === 'ERROR') throw new FleetError('transport', `${machine.id} refused the job: ${ready.rest}`);
    admission = 'admitted';
    const remoteJobDirectory = ready.rest;

    // ---- upload
    io.status(`Uploading to ${machine.id}`);
    try {
      const members = uploadMembers(plan, profile, script, finalizerScript, machine);
      if (profile.sourceTransfer === 'rsync') {
        if (!profile.cache) throw usageError('Rsync needs a named cache with a size limit.');
        const configuration = {
          project: request.project.manifest.id, cache: profile.cache.name,
          cacheBytes: Math.floor(profile.cache.maxGiB * 1024 ** 3),
          cacheConcurrent: profile.cache.concurrent === true,
          maxBytes: Math.floor(request.project.manifest.sync.maxTotalMiB * 1024 ** 2),
          maxFileBytes: Math.floor(request.project.manifest.sync.maxFileMiB * 1024 ** 2),
          digest: plan.digest,
        };
        const metadata = members.filter((member) => member.kind === 'data');
        metadata.push({ kind: 'data', name: 'meta/source-sync.json', mode: 0o600, data: Buffer.from(JSON.stringify(configuration)) });
        metadata.push({ kind: 'data', name: 'meta/source-rsync', mode: 0o600, data: Buffer.from(plan.digest) });
        metadata.push({ kind: 'data', name: 'meta/rsync-receive.py', mode: 0o600, data: readFileSync(new URL('../../remote/rsync_receive.py', import.meta.url)) });
        metadata.push({ kind: 'data', name: 'meta/rsync-worker.py', mode: 0o600, data: readFileSync(new URL('../../remote/rsync_worker.py', import.meta.url)) });
        await upload(transport, remoteJobDirectory, metadata);
        io.status(`Syncing selected source to ${machine.id}`);
        transfer = await syncSource({ transport, remoteJobDirectory, runDirectory, plan, cancelled: () => cancelRequested });
      } else {
        await upload(transport, remoteJobDirectory, members);
      }
    } catch (error) {
      session.send('ABORT');
      throw error;
    }
    session.send('UPLOADED');

    // ---- job
    const started = await session.waitFor(['STARTED', 'RESULT', 'ERROR'], timing.readyTimeoutMs);
    if (started.word !== 'STARTED') {
      const error = session.linesWith('ERROR').at(-1)?.rest;
      throw new FleetError('transport', `${machine.id} didn't start the job${error ? `: ${error}` : '.'}`);
    }
    jobStarted = true;
    state.remoteStartedEpoch = Number(started.rest) || null;
    io.status(`Started on ${machine.id} (timeout ${profile.timeoutMinutes}m)`);

    const safetyDeadline = profile.timeoutMinutes * 60_000 + (profile.finalizer?.timeoutSeconds ?? 0) * 1000 + machine.limits.terminateGraceSeconds * 1000 + timing.safetyMarginMs;
    const result = await session.waitFor(['RESULT'], safetyDeadline).catch(async (error: unknown) => {
      if (!(error instanceof TimeoutWaitingError)) throw error;
      io.status(`No result from ${machine.id} after the timeout; asking it to stop the job.`);
      session.send('CANCEL');
      return session.waitFor(['RESULT'], machine.limits.terminateGraceSeconds * 1000 + 60_000);
    });
    applyRemoteResult(result.rest, state);

    // ---- artifacts, cleanup, lock release
    const next = await session.waitFor(['ARTIFACTS', 'BYE'], timing.finishTimeoutMs);
    if (next.word === 'ARTIFACTS') {
      await session.artifactsWritten();
      try {
        const expectedHashes = new Map(session.linesWith('AF').map((line) => {
          const space = line.rest.indexOf(' ');
          return [line.rest.slice(space + 1), line.rest.slice(0, space)] as const;
        }));
        const extracted = await extractTarSafely(artifactArchive, join(runDirectory, 'artifacts'), {
          allowedRoots: profile.artifacts,
          maxBytes: profile.maxArtifactMiB * 1024 * 1024,
          expectedHashes,
        });
        state.artifacts = [...extracted.files];
        for (const artifact of profile.artifacts) {
          if (!state.artifacts.some((file) => file.path === artifact || file.path.startsWith(`${artifact}/`))) {
            throw new FleetError('artifactVerification', `Declared output ${artifact} has no verified returned content.`);
          }
        }
        session.send('ACK');
      } catch (error) {
        state.artifactError = error instanceof FleetError ? error : new FleetError('artifactVerification', String(error));
        session.send('NACK');
      }
      await session.waitFor(['BYE'], timing.finishTimeoutMs);
    }
  } catch (error) {
    if (error instanceof FleetError) {
      state.failure = error;
    } else if (error instanceof TimeoutWaitingError) {
      state.failure = new FleetError('transport', `No answer from ${machine.id}. It enforces the job timeout itself; check: fleet-runner status --machine ${machine.id}`);
    } else {
      state.failure = new FleetError('transport', error instanceof Error ? error.message : String(error));
    }
  } finally {
    session.closeInput();
    const exited = await Promise.race([session.exited, delay(30_000).then(() => undefined)]);
    if (exited === undefined) session.kill();
    await Promise.all([endStream(stdoutLog), endStream(stderrLog)]);
  }

  // An interrupted upload can throw before the ordinary RESULT wait. Its
  // supervisor still returns the terminal state while finally drains it.
  const terminalResult = session.linesWith('RESULT').at(-1);
  if (terminalResult) applyRemoteResult(terminalResult.rest, state);
  state.lockReleased = session.linesWith('RELEASED').length > 0;
  if (session.linesWith('LOCK-KEPT').some((line) => line.rest !== 'finalizer-failed' && line.rest !== 'scratch cleanup is unverified')) state.stuck = true;
  if (session.linesWith('LOCK-KEPT').some((line) => line.rest === 'scratch cleanup is unverified')) state.notes.push('scratch cleanup is unverified; outputs and ownership retained; verify the volume before retrying recovery');
  if (session.linesWith('FINALIZER-FAILED').length > 0) state.notes.push('finalizer failed; source and lock retained; inspect finalizer.log before explicit lock clear retries it');
  if (state.lockReleased && !state.stuck && (state.reason === 'cancelled' || (cancelRequested && state.reason === 'aborted'))) {
    state.reason = 'cancelled';
    state.failure = null;
  }
  for (const line of session.linesWith('NOTE')) state.notes.push(line.rest);
  for (const line of session.linesWith('ARTIFACT-MISSING')) state.missingArtifacts.push(line.rest);
  for (const line of session.linesWith('ARTIFACT-REJECTED')) state.notes.push(`artifact rejected (symlink or unsafe path): ${line.rest}`);
  if (session.linesWith('ARTIFACTS-TOO-LARGE').length > 0) {
    state.notes.push(`artifacts exceed ${profile.maxArtifactMiB} MiB and were not returned`);
    state.missingArtifacts.push(...profile.artifacts.filter((artifact) => !state.missingArtifacts.includes(artifact)));
  }
  if (state.artifactError) {
    state.missingArtifacts.push(...profile.artifacts.filter((artifact) => !state.missingArtifacts.includes(artifact)));
  }
  // A rejected path or a failed archive is not a returned artifact. Verify
  // actual extracted files rather than trusting the absence of a warning.
  for (const artifact of profile.artifacts) {
    if (!state.artifacts.some((file) => file.path === artifact || file.path.startsWith(`${artifact}/`)) && !state.missingArtifacts.includes(artifact)) {
      state.missingArtifacts.push(artifact);
    }
  }
  if (state.stuck) state.notes.push('job processes did not exit; the lock is kept until they do');

  // ---- success and receipt
  const output = `${readTail(join(runDirectory, 'stdout.log'))}\n${readTail(join(runDirectory, 'stderr.log'))}`;
  const success: SuccessEvaluation = evaluateSuccess({
    profile,
    remoteReason: state.reason ?? 'not-run',
    exitCode: state.exitCode,
    output,
    missingArtifacts: state.missingArtifacts,
  });
  const { outcome, cliExitCode, summary } = decideOutcome({ machine, profile, success, state });
  const finishedAt = new Date();
  const receipt: Receipt = {
    schemaVersion: 1,
    jobId,
    project: request.project.manifest.id,
    profile: profile.name,
    profileKind: profile.kind,
    outcome,
    cliExitCode,
    summary,
    machine: {
      id: machine.id,
      transport: transport.description,
      ...(report.host === undefined ? {} : { host: report.host }),
      ...(report.fingerprint === undefined ? {} : { fingerprint: report.fingerprint }),
    },
    source: {
      root: plan.root,
      digest: plan.digest,
      files: plan.fileCount,
      symlinks: plan.symlinkCount,
      bytes: plan.totalBytes,
      git,
      manifest: 'source-manifest.tsv',
      ...(transfer === undefined ? {} : { transfer }),
    },
    command: {
      argv: profile.argv,
      extraArgs: request.extraArgs,
      prepare: profile.prepare,
      cwd: profile.cwd,
      envNames: [...Object.keys(profile.env), ...Object.keys(machine.env)],
      timeoutSeconds: profile.timeoutMinutes * 60,
      script: 'command.sh',
    },
    timing: {
      requestedAt: requestedAt.toISOString(),
      remoteStartedAt: state.remoteStartedEpoch === null ? null : new Date(state.remoteStartedEpoch * 1000).toISOString(),
      remoteEndedAt: state.remoteEndedEpoch === null ? null : new Date(state.remoteEndedEpoch * 1000).toISOString(),
      finishedAt: finishedAt.toISOString(),
      jobSeconds: state.remoteStartedEpoch !== null && state.remoteEndedEpoch !== null ? state.remoteEndedEpoch - state.remoteStartedEpoch : null,
      totalSeconds: Math.round((finishedAt.getTime() - requestedAt.getTime()) / 1000),
    },
    remote: {
      admission,
      reason: state.reason,
      exitCode: state.exitCode,
      stragglersStopped: state.stragglers,
      processesRemaining: state.stuck,
      lockReleased: state.lockReleased,
      notes: state.notes,
    },
    success: { passed: success.passed, testCount: success.testCount, checks: success.checks },
    artifacts: state.artifacts.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })),
    missingArtifacts: state.missingArtifacts,
    logs: { stdout: 'stdout.log', stderr: 'stderr.log' },
  };
  const receiptPath = writeReceipt(runDirectory, receipt);
  pruneRuns(paths, jobId);

  io.status(summary);
  if (state.failure) for (const detail of state.failure.details) io.status(`  ${detail}`);
  for (const check of success.checks.filter((candidate) => !candidate.passed)) io.status(`  ✗ ${check.name}: ${check.detail}`);
  for (const note of state.notes) io.status(`  note: ${note}`);
  if (state.artifactError) io.status(`  ${state.artifactError.message}`);
  io.status(`Receipt: ${receiptPath}`);
  return { exitCode: cliExitCode, receipt, receiptPath, admission };
}

// Extraction of existing runProfile result parsing, also used after an upload
// abort so a confirmed cancellation is not mistaken for a broken connection.
function applyRemoteResult(rest: string, state: {
  reason: string | null; exitCode: number | null; remoteStartedEpoch: number | null;
  remoteEndedEpoch: number | null; stragglers: boolean; stuck: boolean;
}): void {
  const fields = parseFields(rest);
  state.reason = fields.get('reason') ?? null;
  const exit = Number.parseInt(fields.get('exit_code') ?? '', 10);
  state.exitCode = Number.isFinite(exit) ? exit : null;
  state.remoteStartedEpoch = Number(fields.get('started')) || null;
  state.remoteEndedEpoch = Number(fields.get('ended')) || null;
  state.stragglers = fields.get('stragglers') === '1';
  state.stuck = fields.get('stuck') === '1';
}

function decideOutcome(input: {
  machine: Machine;
  profile: Profile;
  success: SuccessEvaluation;
  state: { reason: string | null; exitCode: number | null; failure: FleetError | null; artifactError: FleetError | null; lockReleased: boolean; stuck: boolean; remoteStartedEpoch: number | null; remoteEndedEpoch: number | null };
}): { outcome: RunOutcomeKind; cliExitCode: number; summary: string } {
  const { machine, profile, success, state } = input;
  const elapsed = state.remoteStartedEpoch !== null && state.remoteEndedEpoch !== null ? ` (${formatDuration(state.remoteEndedEpoch - state.remoteStartedEpoch)})` : '';
  const lockNote = state.stuck ? ' Lock kept: job processes are still running.' : state.lockReleased ? '' : ' Lock release not confirmed; check: fleet-runner status';
  if (state.failure) {
    return { outcome: state.failure.kind === 'machineBusy' ? 'refused' : 'error', cliExitCode: state.failure.exitCode, summary: `${state.failure.message}${lockNote}` };
  }
  if (!state.lockReleased || state.stuck) {
    return { outcome: 'error', cliExitCode: EXIT_CODES.transport, summary: `Cleanup on ${machine.id} is not confirmed.${lockNote}` };
  }
  switch (state.reason) {
    case 'timeout':
      return { outcome: 'timed-out', cliExitCode: EXIT_CODES.timedOut, summary: `Timed out on ${machine.id} after ${profile.timeoutMinutes}m. Job stopped.${lockNote}` };
    case 'cancelled':
    case 'disconnected':
      return { outcome: 'cancelled', cliExitCode: EXIT_CODES.cancelled, summary: `Cancelled on ${machine.id}. Job stopped.${lockNote}` };
    case 'completed':
      break;
    default:
      return { outcome: 'error', cliExitCode: EXIT_CODES.transport, summary: `Job on ${machine.id} ended without running (${state.reason ?? 'no result'}).${lockNote}` };
  }
  if (state.artifactError) {
    return { outcome: 'failed', cliExitCode: EXIT_CODES.artifactVerification, summary: `Artifacts from ${machine.id} failed verification.${lockNote}` };
  }
  const tests = success.testCount === null ? '' : `${success.testCount} test${success.testCount === 1 ? '' : 's'}, `;
  if (success.passed) {
    return { outcome: 'passed', cliExitCode: EXIT_CODES.ok, summary: `Passed on ${machine.id}: ${tests}exit 0${elapsed}${lockNote}` };
  }
  const reason = state.exitCode !== 0 ? `exit ${state.exitCode ?? 'unknown'}` : `exit 0 but ${success.checks.find((check) => !check.passed)?.detail ?? 'a success check failed'}`;
  return { outcome: 'failed', cliExitCode: EXIT_CODES.jobFailed, summary: `Failed on ${machine.id}: ${tests}${reason}${elapsed}${lockNote}` };
}

async function upload(transport: Transport, remoteJobDirectory: string, members: TarMember[]): Promise<void> {
  const process = transport.start(uploadCommand(remoteJobDirectory));
  let stderr = '';
  process.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-4000);
  });
  process.stdout.resume();
  try {
    await pipeline(Readable.from(tarStream(members)), process.stdin);
  } catch (error) {
    process.kill();
    await process.exited;
    if (error instanceof SourceChangedError) throw error;
    throw new FleetError('transport', 'Upload failed.', firstLines(stderr, 3));
  }
  const exit = await process.exited;
  if (exit.code !== 0) throw new FleetError('transport', `Upload failed (exit ${exit.code ?? exit.signal ?? 'unknown'}).`, firstLines(stderr, 3));
}

// Success patterns are matched against at most the last 32 MiB of each log.
const OUTPUT_TAIL_BYTES = 32 * 1024 * 1024;

function readTail(path: string): string {
  try {
    const size = statSync(path).size;
    if (size <= OUTPUT_TAIL_BYTES) return readFileSync(path, 'utf8');
    const buffer = readFileSync(path);
    return buffer.subarray(buffer.length - OUTPUT_TAIL_BYTES).toString('utf8');
  } catch {
    return '';
  }
}

function endStream(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve) => stream.end(resolve));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
