// Interprets the remote machine check (remote/preflight.sh output).
//
// Parsing and policy are pure functions so they are unit-tested without a
// machine. Policy decisions:
// - The heavy-job lock is checked first: busy or stale refuses the run. There
//   is no wait/retry loop; the caller decides when to try again.
// - Builds started by other chats don't take this runner's lock, so heavy
//   processes found by name refuse the run by default (configurable to warn
//   per machine, or skipped once with --ignore-heavy-processes).
// - Disk and memory thresholds are per machine. The memory figure is an
//   estimate, so the kernel's pressure level is a separate check.
// - Missing tools and a missing GUI session refuse only when the profile
//   declares that requirement.

import type { Machine } from '../schema/machines.ts';
import type { Profile } from '../schema/manifest.ts';
import { e2eLimit, profileWorkload, profileClaim } from './capacity.ts';

export type LockState =
  | { readonly state: 'free' }
  | { readonly state: 'busy'; readonly jobId: string; readonly startedEpoch?: number; readonly label: string; readonly orphaned: boolean }
  | { readonly state: 'stale'; readonly jobId: string; readonly startedEpoch?: number; readonly label: string };

export interface HeavyProcess {
  readonly pid: number;
  readonly pgid: number;
  readonly rssKiB: number;
  readonly cpuPercent: number;
  readonly name: string;
}

export interface ProcessSnapshot extends HeavyProcess {
  readonly ppid: number;
  readonly uid: number;
  readonly elapsed: string;
}

export interface PreflightReport {
  readonly complete: boolean;
  readonly os?: string;
  readonly arch?: string;
  readonly host?: string;
  readonly user?: string;
  readonly bashVersion?: string;
  readonly fingerprint?: string;
  /** Display only: hardware model identifier (macOS hw.model, Linux DMI product name). */
  readonly model?: string;
  /** Display only: processor name, such as "Apple M4". */
  readonly cpuBrand?: string;
  /** Display only: OS release, such as "26.1" on macOS. */
  readonly osVersion?: string;
  readonly rootExists: boolean;
  readonly diskFreeBytes?: number;
  readonly memTotalBytes?: number;
  readonly memAvailableBytes?: number;
  /** macOS kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical. */
  readonly memPressureLevel?: number;
  readonly swapUsedMiB?: number;
  /** Top 20 by resident memory, names only. Never used for kill/admission policy. */
  readonly processes?: readonly ProcessSnapshot[];
  readonly processCount?: number;
  readonly processSampleComplete?: boolean;
  readonly cpuCount?: number;
  readonly loadAverage?: readonly number[];
  readonly guiSession: boolean;
  readonly bsdtar: boolean;
  readonly missingBaseTools: readonly string[];
  readonly tools: ReadonlyMap<string, boolean>;
  readonly heavy: readonly HeavyProcess[];
  readonly lock: LockState;
  readonly sharedLocks?: readonly LockState[];
  readonly sharedWorkloads?: Readonly<Record<string, 'standard' | 'e2e'>>;
  readonly managedPgids?: readonly number[];
  /** Fresh kernel probe used for recovery, never inferred from owner files. */
  readonly admissionFree?: boolean;
}

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseLockState(text: string): LockState {
  const [state, jobId = '-', started = '-', label = '-', detail] = text.trim().split(' ');
  const startedEpoch = optionalNumber(started === '-' ? undefined : started);
  const base = { jobId, label, ...(startedEpoch === undefined ? {} : { startedEpoch }) };
  if (state === 'free') return { state: 'free' };
  if (state === 'stale') return { state: 'stale', ...base };
  return { state: 'busy', ...base, orphaned: detail === 'orphaned-processes' };
}

export function parsePreflight(text: string): PreflightReport {
  const values = new Map<string, string>();
  const tools = new Map<string, boolean>();
  const heavy: HeavyProcess[] = [];
  const missingBaseTools: string[] = [];
  const sharedLocks: LockState[] = [];
  const sharedWorkloads: Record<string, 'standard' | 'e2e'> = {};
  const managedPgids: number[] = [];
  for (const line of text.split('\n')) {
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    const key = line.slice(0, equals);
    const value = line.slice(equals + 1);
    if (key === 'shared_lock') {
      const lock = parseLockState(value);
      if (lock.state !== 'free') sharedLocks.push(lock);
    } else if (key === 'shared_workload') {
      const [id, workload] = value.split(' ');
      if (id && (workload === 'standard' || workload === 'e2e')) sharedWorkloads[id] = workload;
    } else if (key === 'managed_pgid') {
      if (/^[1-9][0-9]*$/.test(value)) managedPgids.push(Number(value));
    } else if (key === 'tool') {
      const [name = '', status] = value.split(' ');
      tools.set(name, status === 'found');
    } else if (key === 'heavy') {
      const [pid, pgid, rss, cpu, ...name] = value.split(' ');
      heavy.push({ pid: Number(pid), pgid: Number(pgid), rssKiB: Number(rss), cpuPercent: Number(cpu), name: name.join(' ') });
    } else if (key === 'missing_base_tool') {
      missingBaseTools.push(value);
    } else {
      values.set(key, value);
    }
  }
  const diskFreeKiB = optionalNumber(values.get('disk_free_kb'));
  const swapUsedMiB = optionalNumber(values.get('swap_used_mb'));
  const memTotalBytes = optionalNumber(values.get('mem_total_bytes'));
  const memAvailableBytes = optionalNumber(values.get('mem_available_bytes'));
  const memPressureLevel = optionalNumber(values.get('mem_pressure_level'));
  const cpuCount = optionalNumber(values.get('cpu_count'));
  const loadAverage = values.get('load_average')?.split(/\s+/).map(Number).filter(Number.isFinite);
  const optionalText = (key: string): Record<string, string> => {
    const value = values.get(key);
    return value === undefined || value === '' ? {} : { [key]: value };
  };
  const identityFields = { ...optionalText('os'), ...optionalText('arch'), ...optionalText('host'), ...optionalText('user'), ...optionalText('fingerprint'), ...optionalText('model') };
  const renamed = (key: string, name: string): Record<string, string> => {
    const value = values.get(key);
    return value === undefined || value === '' ? {} : { [name]: value };
  };
  const bashVersion = values.get('bash_version');
  let processes: ProcessSnapshot[] | undefined;
  try {
    const candidate: unknown = JSON.parse(values.get('processes_json') ?? 'null');
    if (Array.isArray(candidate) && candidate.length <= 20 && candidate.every((p: unknown) => {
      if (!p || typeof p !== 'object') return false;
      const row = p as Record<string, unknown>;
      return ['pid', 'ppid', 'pgid', 'uid', 'rssKiB', 'cpuPercent'].every((key) => typeof row[key] === 'number' && Number.isFinite(row[key]) && Number(row[key]) >= 0)
        && typeof row['name'] === 'string' && typeof row['elapsed'] === 'string';
    })) processes = candidate as ProcessSnapshot[];
  } catch { /* Older or incomplete workers still report their existing health. */ }
  const processCount = optionalNumber(values.get('process_count'));
  return {
    complete: values.get('done') === '1',
    ...identityFields,
    ...renamed('cpu_brand', 'cpuBrand'),
    ...renamed('os_version', 'osVersion'),
    ...(bashVersion ? { bashVersion } : {}),
    rootExists: values.get('root_exists') === '1',
    ...(diskFreeKiB === undefined ? {} : { diskFreeBytes: diskFreeKiB * 1024 }),
    ...(memTotalBytes === undefined ? {} : { memTotalBytes }),
    ...(memAvailableBytes === undefined ? {} : { memAvailableBytes }),
    ...(memPressureLevel === undefined ? {} : { memPressureLevel }),
    ...(swapUsedMiB === undefined ? {} : { swapUsedMiB }),
    ...(processes === undefined ? {} : { processes }),
    ...(processCount === undefined ? {} : { processCount }),
    processSampleComplete: values.get('process_sample') === '1' && processes !== undefined,
    ...(cpuCount === undefined ? {} : { cpuCount }),
    ...(loadAverage?.length === 3 ? { loadAverage } : {}),
    guiSession: values.get('gui_session') === '1',
    bsdtar: values.get('tar') === 'bsdtar',
    missingBaseTools,
    tools,
    heavy,
    lock: parseLockState(values.get('lock') ?? 'busy - - - unknown'),
    sharedLocks, sharedWorkloads,
    managedPgids,
    ...(values.has('admission_free') ? { admissionFree: values.get('admission_free') === '1' } : {}),
  };
}

export interface PreflightFinding {
  readonly kind: 'busy' | 'stale' | 'disk' | 'memory' | 'pressure' | 'heavy' | 'tool' | 'gui' | 'base-tool' | 'incomplete';
  readonly message: string;
}

export interface PreflightDecision {
  readonly refusals: readonly PreflightFinding[];
  readonly warnings: readonly PreflightFinding[];
}

const GIB = 1024 ** 3;

export function formatGiB(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function describeLock(machine: Machine, lock: LockState, nowEpoch: number): PreflightFinding | undefined {
  switch (lock.state) {
    case 'free':
      return undefined;
    case 'busy': {
      if (lock.orphaned) {
        return {
          kind: 'busy',
          message: `${machine.id} is busy: processes from job ${lock.jobId} are still running without their supervisor. Stop them with: fleet-runner cancel --machine ${machine.id} --job ${lock.jobId}`,
        };
      }
      const running = lock.startedEpoch === undefined ? '' : ` for ${formatDuration(nowEpoch - lock.startedEpoch)}`;
      const what = lock.label === '-' ? `job ${lock.jobId}` : `${lock.label} (job ${lock.jobId})`;
      return { kind: 'busy', message: `${machine.id} is busy: ${what} running${running}` };
    }
    case 'stale':
      return {
        kind: 'stale',
        message: `${machine.id} has a stale lock from job ${lock.jobId}. Its processes have exited. Clear it with: fleet-runner lock clear --machine ${machine.id} --job ${lock.jobId}`,
      };
  }
}

export function evaluatePreflight(
  report: PreflightReport,
  machine: Machine,
  profile: Profile | undefined,
  options: { readonly ignoreHeavyProcesses: boolean; readonly nowEpoch: number },
): PreflightDecision {
  const refusals: PreflightFinding[] = [];
  const warnings: PreflightFinding[] = [];
  if (!report.complete) {
    refusals.push({ kind: 'incomplete', message: `Machine check on ${machine.id} didn't finish.` });
    return { refusals, warnings };
  }
  const lock = describeLock(machine, report.lock, options.nowEpoch);
  if (lock) refusals.push(lock);
  const shared = profile === undefined || profileClaim(profile, machine).mode === 'shared';
  const sharedLocks = (report.sharedLocks ?? []).filter((entry) => entry.state !== 'free');
  if (sharedLocks.length && (!shared || sharedLocks.length >= machine.limits.maxConcurrentJobs || sharedLocks.some((entry) => entry.jobId === '-'))) {
    const stale = sharedLocks.find((entry) => entry.state === 'stale');
    refusals.push((stale && describeLock(machine, stale, options.nowEpoch)) || { kind: 'busy', message: `${machine.id}: shared job capacity is occupied or requires recovery (${sharedLocks.map((entry) => entry.jobId).join(', ')})` });
  }

  if (profile && profileWorkload(profile) === 'e2e' && sharedLocks.filter((lock) => report.sharedWorkloads?.[lock.jobId] !== 'standard').length >= e2eLimit(machine)) {
    refusals.push({ kind: 'busy', message: `${machine.id}: E2E job slots are occupied.` });
  }

  for (const tool of report.missingBaseTools) {
    refusals.push({ kind: 'base-tool', message: `${machine.id} is missing ${tool}, which the runner needs.` });
  }

  const limits = machine.limits;
  if (report.diskFreeBytes !== undefined && report.diskFreeBytes < limits.minFreeDiskGiB * GIB) {
    refusals.push({ kind: 'disk', message: `Not enough free disk on ${machine.id}: ${formatGiB(report.diskFreeBytes)} free, ${limits.minFreeDiskGiB} GiB required` });
  }
  if (report.memAvailableBytes !== undefined && report.memAvailableBytes < limits.minAvailableMemoryGiB * GIB) {
    refusals.push({
      kind: 'memory',
      message: `Not enough available memory on ${machine.id}: about ${formatGiB(report.memAvailableBytes)}, ${limits.minAvailableMemoryGiB} GiB required`,
    });
  }
  if (report.memPressureLevel !== undefined && report.memPressureLevel >= 2) {
    const critical = report.memPressureLevel >= 4;
    const message = `${machine.id} is under ${critical ? 'critical' : 'elevated'} memory pressure`;
    const refuse = limits.memoryPressure === 'refuse-warn' || (limits.memoryPressure === 'refuse-critical' && critical);
    (refuse ? refusals : warnings).push({ kind: 'pressure', message });
  }

  const heavy = shared ? report.heavy.filter((process) => !report.managedPgids?.includes(process.pgid)) : report.heavy;
  if (heavy.length > 0) {
    const counts = new Map<string, number>();
    for (const process of heavy) counts.set(process.name, (counts.get(process.name) ?? 0) + 1);
    const summary = [...counts.entries()].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(', ');
    const message = `${machine.id} is already running heavy work: ${summary}. Other chats' builds don't take this runner's lock.`;
    if (limits.heavyProcessAction === 'refuse' && !options.ignoreHeavyProcesses) {
      refusals.push({ kind: 'heavy', message: `${message} Wait, or pass --ignore-heavy-processes.` });
    } else {
      warnings.push({ kind: 'heavy', message });
    }
  }

  if (profile) {
    for (const tool of profile.requires.tools) {
      if (report.tools.get(tool) !== true) refusals.push({ kind: 'tool', message: `${tool} isn't on ${machine.id}'s PATH for this job` });
    }
    if (profile.requires.guiSession && !report.guiSession) {
      refusals.push({ kind: 'gui', message: `${profile.name} needs ${machine.id}'s GUI session, but ${report.user ?? 'the remote user'} isn't the console user` });
    }
  }
  return { refusals, warnings };
}
