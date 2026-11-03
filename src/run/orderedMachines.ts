// Default-first and explicit remote-only worker selection for Fleet runs.
// Read-only refusals and a conclusive BUSY response may advance the list.
// Once admission succeeds or becomes uncertain, the run owns that choice:
// never replay tests on another machine, even after a transfer/start failure.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { FleetError, usageError } from '../errors.ts';
import { findMachine, type Machine, type MachinesRegistry } from '../schema/machines.ts';
import type { Transport } from '../transport/transport.ts';
import { evaluatePreflight } from './preflight.ts';
import { fetchPreflight } from './remoteChecks.ts';
import { getProfile, runProfile, type RunRequest, type RunResult } from './runJob.ts';
import { reportDiskSpaceProblem } from './diskSpace.ts';

const execFileAsync = promisify(execFile);

/** Extraction of existing normalizedArguments default-first ordering.
 * Saved runs and one-time requests share this rule; a valid default alias
 * resolves to its one registered machine without changing registry order.
 */
export function defaultMachineNames(registry: MachinesRegistry): string[] {
  const names = registry.machines.map((machine) => machine.id);
  const preferred = registry.defaultMachine === undefined ? undefined : findMachine(registry, registry.defaultMachine)?.id;
  if (preferred !== undefined) {
    names.splice(names.indexOf(preferred), 1);
    names.unshift(preferred);
  }
  return names;
}

export function orderedMachines(registry: MachinesRegistry, names: readonly string[]): Machine[] {
  if (names.length === 0 || names.some((name) => name.trim() === '')) throw usageError('--machines needs a comma-separated list of machine names.');
  const selected = new Set<string>();
  return names.map((name) => {
    const machine = findMachine(registry, name.trim());
    if (!machine) throw usageError(`Unknown machine "${name}". Run: fleet-runner machines`);
    if (selected.has(machine.id)) throw usageError(`${machine.id} appears more than once in --machines, including its aliases.`);
    selected.add(machine.id);
    return machine;
  });
}

/** Same hashed physical identity as remote/preflight.sh; never expose the UUID. */
export async function localMachineFingerprint(): Promise<string> {
  let identity: string | undefined;
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { timeout: 10_000 });
      identity = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout)?.[1];
    } catch { /* Match the remote check's fallback below. */ }
  }
  if (!identity) identity = await readFile('/etc/machine-id', 'utf8').then((value) => value.trim()).catch(() => undefined);
  if (!identity) throw new FleetError('machineCheckRefused', 'Cannot confirm this computer’s physical identity for --machines.');
  return createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

export interface OrderedRunRequest extends Omit<RunRequest, 'machine' | 'transport' | 'preflightReport'> {
  readonly machines: readonly Machine[];
  readonly transportFor: (machine: Machine) => Transport;
  /** Controlled fixtures supply a separate dispatcher identity. */
  readonly dispatcherFingerprint?: string;
  /** Null means another client holds a coordinator reservation; no job started. */
  readonly runOne?: (request: RunRequest) => Promise<RunResult | null>;
  readonly beforePreflight?: (machine: Machine) => Promise<void>;
}

export async function runOnOrderedMachines(request: OrderedRunRequest): Promise<RunResult> {
  const profile = getProfile(request.project, request.profileName);
  const dispatcher = request.dispatcherFingerprint ?? await localMachineFingerprint();
  const skipped: string[] = [];
  const seenPhysicalMachines = new Set<string>();
  for (const machine of request.machines) {
    if (request.interrupts?.requested) throw new FleetError('cancelled', 'Run cancelled before admission.');
    let transport: Transport;
    try { transport = request.transportFor(machine); }
    catch (error) {
      skipped.push(`${machine.id}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const missingEnv = profile.requires.machineEnv.filter((name) => machine.env[name] === undefined);
    if (missingEnv.length > 0) {
      skipped.push(`${machine.id}: missing machine env ${missingEnv.join(', ')}`);
      continue;
    }
    if (profile.sourceTransfer === 'rsync' && !transport.startRsync) {
      skipped.push(`${machine.id}: transport does not support rsync`);
      continue;
    }
    let report;
    try {
      await request.beforePreflight?.(machine);
      report = await fetchPreflight(transport, machine, profile.pathPrepend, [...profile.requires.tools, ...(profile.sourceTransfer === 'rsync' ? ['rsync'] : [])]);
    } catch (error) {
      skipped.push(`${machine.id}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!report.fingerprint || report.fingerprint === dispatcher) {
      skipped.push(`${machine.id}: ${report.fingerprint ? 'this is the dispatching computer' : 'physical identity was not confirmed'}`);
      continue;
    }
    if (seenPhysicalMachines.has(report.fingerprint)) {
      skipped.push(`${machine.id}: physical machine already tried`);
      continue;
    }
    seenPhysicalMachines.add(report.fingerprint);
    const decision = evaluatePreflight(report, machine, profile, { ignoreHeavyProcesses: request.ignoreHeavyProcesses, nowEpoch: Math.floor(Date.now() / 1000) });
    if (decision.refusals.length > 0) {
      for (const finding of decision.refusals) if (finding.kind === 'disk') {
        reportDiskSpaceProblem(request.io.onDiskSpaceProblem, { machineId: machine.id, phase: 'admission', message: finding.message });
      }
      skipped.push(`${machine.id}: ${decision.refusals.map((finding) => finding.message).join('; ')}`);
      continue;
    }
    request.io.status(`Trying ${machine.id}`);
    if (request.interrupts?.requested) throw new FleetError('cancelled', 'Run cancelled before admission.');
    // runProfile returns a typed admission result, not an arbitrary exit-code
    // retry rule. A failed test or an uncertain connection stops this loop.
    const result = await (request.runOne ?? runProfile)({ ...request, machine, transport, preflightReport: report });
    if (result === null) {
      skipped.push(`${machine.id}: reserved by another client`);
      continue;
    }
    if (result.admission !== 'refused') return result;
    skipped.push(`${machine.id}: admission refused (busy)`);
  }
  throw new FleetError('machineBusy', 'No available remote workers in --machines.', skipped);
}
