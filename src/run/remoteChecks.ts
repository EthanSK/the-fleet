// Read-only and control calls to a fleet machine: preflight, status, cancel,
// stale-lock clearing. Each is one short ssh command with a bounded timeout.

import { FleetError } from '../errors.ts';
import { controlCommand, preflightCommand, type ControlAction } from '../remote/remoteScripts.ts';
import type { Machine } from '../schema/machines.ts';
import { firstLines, runCaptured, type Transport } from '../transport/transport.ts';
import { parseLockState, parsePreflight, type LockState, type PreflightReport } from './preflight.ts';
import { parseArchiveDiskSpaceProblem, type DiskSpaceProblem } from './diskSpace.ts';

export async function fetchPreflight(transport: Transport, machine: Machine, pathPrepend: readonly string[], tools: readonly string[]): Promise<PreflightReport> {
  const result = await runCaptured(transport, preflightCommand(machine, pathPrepend, tools), { timeoutMs: 45_000 });
  const report = parsePreflight(result.stdout);
  if (!report.complete) {
    throw new FleetError('transport', `Machine check on ${machine.id} failed (exit ${result.exit.code ?? result.exit.signal ?? 'unknown'}).`, firstLines(result.stderr, 3));
  }
  return report;
}

export interface RemoteJobSummary {
  readonly jobId: string;
  readonly reason: string;
  readonly exitCode: string;
  readonly startedEpoch?: number;
  readonly endedEpoch?: number;
  readonly label: string;
}

export interface RemoteStatus {
  readonly lock: LockState;
  readonly sharedLocks?: readonly LockState[];
  readonly jobsKiB?: number;
  readonly jobs: readonly RemoteJobSummary[];
  readonly caches: readonly { readonly name: string; readonly kib: number }[];
}

export async function fetchStatus(transport: Transport, machine: Machine): Promise<RemoteStatus> {
  const result = await runCaptured(transport, controlCommand(machine, 'status'), { timeoutMs: 45_000 });
  if (result.exit.code !== 0) throw new FleetError('transport', `Status check on ${machine.id} failed.`, firstLines(result.stderr, 3));
  let lock: LockState = { state: 'free' };
  const sharedLocks: LockState[] = [];
  let jobsKiB: number | undefined;
  const jobs: RemoteJobSummary[] = [];
  const caches: { name: string; kib: number }[] = [];
  for (const line of result.stdout.split('\n')) {
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    const key = line.slice(0, equals);
    const value = line.slice(equals + 1);
    if (key === 'lock') lock = parseLockState(value);
    if (key === 'shared_lock') {
      const shared = parseLockState(value);
      if (shared.state !== 'free') sharedLocks.push(shared);
    }
    if (key === 'jobs_kb') jobsKiB = Number(value);
    if (key === 'job') {
      const [jobId = '', reason = '', exitCode = '-', started = '-', ended = '-', label = ''] = value.split(' ');
      const startedEpoch = Number(started);
      const endedEpoch = Number(ended);
      jobs.push({
        jobId,
        reason,
        exitCode,
        label,
        ...(Number.isFinite(startedEpoch) && started !== '' && started !== '-' ? { startedEpoch } : {}),
        ...(Number.isFinite(endedEpoch) && ended !== '' && ended !== '-' ? { endedEpoch } : {}),
      });
    }
    if (key === 'cache') {
      const [name = '', kib = '0'] = value.split(' ');
      caches.push({ name, kib: Number(kib) });
    }
  }
  return { lock, sharedLocks, jobs, caches, ...(jobsKiB === undefined || !Number.isFinite(jobsKiB) ? {} : { jobsKiB }) };
}

export interface ControlResult {
  readonly result: string;
  readonly detail: string;
  readonly diskSpaceProblem?: DiskSpaceProblem;
}

export async function runControl(transport: Transport, machine: Machine, action: Exclude<ControlAction, 'status'>, expectedJobId?: string): Promise<ControlResult> {
  const result = await runCaptured(transport, controlCommand(machine, action, expectedJobId), { timeoutMs: 120_000 });
  const line = result.stdout.split('\n').find((candidate) => candidate.startsWith('result='));
  if (result.exit.code !== 0 || line === undefined) throw new FleetError('transport', `Control call on ${machine.id} failed.`, firstLines(result.stderr, 3));
  const value = line.slice('result='.length);
  const space = value.indexOf(' ');
  const diskLine = result.stdout.split('\n').find((candidate) => candidate.startsWith('disk_space_problem='));
  const diskSpaceProblem = diskLine === undefined ? undefined : parseArchiveDiskSpaceProblem(diskLine.slice('disk_space_problem='.length), machine.id);
  return { ...(space === -1 ? { result: value, detail: '' } : { result: value.slice(0, space), detail: value.slice(space + 1) }),
    ...(diskSpaceProblem === undefined ? {} : { diskSpaceProblem }) };
}
