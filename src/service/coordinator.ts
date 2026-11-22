// The Fleet's single admission point. Previously every fleet-runner CLI made
// its own selection; remote locks remain authoritative for actual execution.
// Reservations coordinate cooperating apps, including agents using their own
// SSH after discovery. Expiry never silently releases unknown external work.
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StatePaths } from '../paths.ts';
import { ensurePrivateDir } from '../paths.ts';
import { loadMachines } from '../registry.ts';
import { FleetError, RunNotStartedError } from '../errors.ts';
import type { Machine } from '../schema/machines.ts';
import { loadAgentBridgeRoute, type AgentBridgeRoute } from '../transport/agentBridgeConfig.ts';
import { SshTransport } from '../transport/sshTransport.ts';
import type { PortForward, RemoteProcess } from '../transport/transport.ts';
import { PortForwarding, type ForwardingOptions, type PublicForwarding } from './forwarding.ts';
import { fetchPreflight, fetchStatus, runControl, type RemoteStatus, type ControlResult } from '../run/remoteChecks.ts';
import { evaluatePreflight, type PreflightReport } from '../run/preflight.ts';
import { assessMemory } from '../run/memoryAssessment.ts';
import { compareWorkerMemory, defaultMachineNames, localMachineFingerprint } from '../run/orderedMachines.ts';
import { getProfile, makeJobId, runProfile, type RunRequest, type RunResult } from '../run/runJob.ts';
import { e2eLimit, claimsConflict, parseClaim, profileClaim, type CapacityClaim } from '../run/capacity.ts';
import { reportDiskSpaceProblem, type DiskSpaceProblemHandler } from '../run/diskSpace.ts';

export interface WorkerObservation {
  readonly machine: Machine;
  readonly observedAt: string;
  readonly report?: PreflightReport;
  readonly recent?: RemoteStatus;
  readonly error?: string;
}
export interface Reservation {
  /** Missing on old stores: those leases retain exclusive compatibility. */
  claim?: CapacityClaim;
  readonly jobId?: string;
  readonly id: string;
  readonly machineId: string;
  readonly fingerprint: string;
  readonly owner: string;
  readonly label: string;
  readonly kind: 'external' | 'managed';
  readonly createdAt: string;
  expiresAt: string | null;
  tokenHash: string;
  state: 'active' | 'expired' | 'unverified';
}
export type PublicReservation = Omit<Reservation, 'tokenHash'> & { readonly forwarding?: PublicForwarding };
/** Paired route and worker paths for an external reservation owner. */
export type ReservationConnection = AgentBridgeRoute & Pick<Machine, 'remoteRoot' | 'pathPrepend'> & { readonly dockerContext?: string };
export interface CoordinatorDependencies {
  readonly machines: () => readonly Machine[];
  readonly preferredMachine?: () => string | undefined;
  readonly inspect: (machine: Machine, recoveryJobs?: readonly string[]) => Promise<WorkerObservation>;
  readonly localFingerprint: () => Promise<string>;
  readonly execute: (request: RunRequest) => Promise<RunResult>;
  readonly now: () => number;
  readonly route: (machine: Machine) => AgentBridgeRoute;
  readonly cleanupStale?: (machine: Machine, expectedJobId: string) => Promise<ControlResult>;
  /** Starts one ssh session holding the forwards; absent when this coordinator cannot forward (tests without a transport). */
  readonly forward?: (machine: Machine, forwards: readonly PortForward[]) => RemoteProcess;
  /** Test-only timing for forwarding readiness and reconnection. */
  readonly forwardingOptions?: Omit<ForwardingOptions, 'now'>;
}

export function productionDependencies(paths: StatePaths): CoordinatorDependencies {
  return {
    machines: () => loadMachines(paths).machines,
    preferredMachine: () => defaultMachineNames(loadMachines(paths))[0],
    inspect: async (machine, recoveryJobs) => {
      const observedAt = new Date().toISOString();
      try {
        const transport = SshTransport.forMachine(machine);
        const report = await fetchPreflight(transport, machine, [], [], recoveryJobs);
        // Recovery only needs ownership evidence. Inventorying the whole jobs
        // and caches directories can be slow on a worker keeping large outputs.
        const recent = recoveryJobs === undefined ? await fetchStatus(transport, machine).catch(() => undefined) : undefined;
        return { machine, observedAt, report, ...(recent ? { recent } : {}) };
      } catch (error) {
        return { machine, observedAt, error: error instanceof Error ? error.message : 'Worker inspection failed' };
      }
    },
    localFingerprint: localMachineFingerprint,
    execute: runProfile,
    now: Date.now,
    cleanupStale: (machine, jobId) => runControl(SshTransport.forMachine(machine), machine, 'reap-stale', jobId),
    route: (machine) => loadAgentBridgeRoute(machine.transport.target, machine.transport.configPath),
    forward: (machine, forwards) => SshTransport.forMachine(machine).startForwarding(forwards),
  };
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const publicReservation = ({ tokenHash: _secret, ...value }: Reservation): PublicReservation => value;

export interface ProbeResult {
  readonly observation: WorkerObservation;
  /** True when the candidate is the computer running this coordinator. */
  readonly dispatchingComputer: boolean;
  /** A registered worker with the same physical identity. */
  readonly sameAs?: string;
}

export interface MaintenanceResult {
  readonly machineId: string;
  readonly observedAt: string;
  readonly cleanup: { readonly status: 'not-needed' | 'reserved' | 'unverified' | 'cleared' | 'retained'; readonly jobId?: string; readonly result?: string };
  readonly memory?: ReturnType<typeof assessMemory>;
}

export class Coordinator {
  private readonly reservations = new Map<string, Reservation>();
  /** Live ssh forwards by reservation id. Not persisted: a restarted service holds no ssh children, so owners re-request them. */
  private readonly forwardings = new Map<string, PortForwarding>();
  private readonly releasing = new Set<string>();
  private readonly observations = new Map<string, { at: number; value: Promise<WorkerObservation> }>();
  /** Last confirmed physical identity per worker id, for synchronous ownership checks. */
  private readonly fingerprints = new Map<string, string>();
  private readonly maintenance = new Map<string, MaintenanceResult>();
  private maintenancePending = 0;
  private readonly file: string;
  private readonly dependencies: CoordinatorDependencies;
  private readonly mode: 'serve' | 'offline-recovery';

  constructor(paths: StatePaths, dependencies = productionDependencies(paths), mode: 'serve' | 'offline-recovery' = 'serve') {
    this.dependencies = dependencies;
    this.mode = mode;
    ensurePrivateDir(paths.home);
    this.file = join(paths.home, 'reservations.json');
    if (existsSync(this.file)) {
      const value: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!Array.isArray(value)) throw new Error('Invalid reservation store; preserve it for recovery.');
      for (const item of value) {
        if (!item || typeof item !== 'object' ||
          !['id', 'machineId', 'fingerprint', 'owner', 'label', 'tokenHash'].every((key) => typeof item[key] === 'string' && item[key].length > 0) ||
          !/^[a-f0-9]{64}$/.test(item.tokenHash) ||
          !['external', 'managed'].includes(item.kind) || !['active', 'expired', 'unverified'].includes(item.state) ||
          !Number.isFinite(Date.parse(item.createdAt)) || (item.expiresAt !== null && !Number.isFinite(Date.parse(item.expiresAt)))) {
          throw new Error('Invalid reservation; preserve the store for recovery.');
        }
        // A restarted coordinator cannot infer that the former client's work ended.
        this.reservations.set(item.id, { ...item, ...(item.claim === undefined ? {} : { claim: parseClaim(item.claim) }), state: mode === 'serve' ? 'unverified' : item.state } as Reservation);
      }
    }
  }

  private persist(): void {
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify([...this.reservations.values()], null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  private expire(): void {
    for (const reservation of this.reservations.values()) {
      if (reservation.state === 'active' && reservation.expiresAt && Date.parse(reservation.expiresAt) <= this.dependencies.now()) reservation.state = 'expired';
    }
  }

  private held(fingerprint: string): Reservation | undefined {
    this.expire();
    return [...this.reservations.values()].find((lease) => lease.fingerprint === fingerprint);
  }

  private claims(fingerprint: string): Reservation[] {
    this.expire();
    return [...this.reservations.values()].filter((lease) => lease.fingerprint === fingerprint);
  }

  private capacityUsed(fingerprint: string, report?: PreflightReport): number {
    const held = this.claims(fingerprint);
    const knownJobs = new Set(held.map((lease) => lease.jobId).filter((job) => job !== undefined));
    return held.length + (report?.sharedLocks ?? []).filter((lock) => lock.state !== 'free' && !knownJobs.has(lock.jobId)).length;
  }

  /** Counts both local leases and unmatched remote owners for placement diagnostics. */
  selectionUsage(machine: Machine, report: PreflightReport): number {
    return report.fingerprint ? this.capacityUsed(report.fingerprint, report) : this.reservationsFor(machine).length;
  }

  private e2eUsed(fingerprint: string, report?: PreflightReport): number {
    const held = this.claims(fingerprint);
    const knownJobs = new Set(held.map((lease) => lease.jobId));
    // Unknown old managed work counts conservatively until its ownership is released.
    return held.filter((lease) => lease.claim?.workload === 'e2e' || (lease.kind === 'managed' && lease.claim?.workload === undefined)).length
      + (report?.sharedLocks ?? []).filter((lock) => lock.state !== 'free' && !knownJobs.has(lock.jobId) && report?.sharedWorkloads?.[lock.jobId] !== 'standard').length;
  }

  private accepts(fingerprint: string, claim: CapacityClaim, machine: Machine, report?: PreflightReport): boolean {
    const held = this.claims(fingerprint);
    return (claim.workload !== 'e2e' || this.e2eUsed(fingerprint, report) < e2eLimit(machine))
      && this.capacityUsed(fingerprint, report) < machine.limits.maxConcurrentJobs && held.every((lease) => !claimsConflict(claim, lease.claim ?? { mode: 'exclusive', resources: [] }));
  }

  private remoteLocksFree(report: PreflightReport): boolean {
    return report.complete && report.lock.state === 'free' && !(report.sharedLocks?.length)
      && report.admissionFree !== false;
  }

  private remoteIdle(report: PreflightReport): boolean {
    return this.remoteLocksFree(report) && !report.heavy.length;
  }

  private inspect(machine: Machine, fresh: boolean, recoveryJobs?: readonly string[]): Promise<WorkerObservation> {
    const current = this.observations.get(machine.id);
    if (!fresh && current && this.dependencies.now() - current.at < 5000) return current.value;
    const value = this.dependencies.inspect(machine, recoveryJobs);
    if (recoveryJobs === undefined) this.observations.set(machine.id, { at: this.dependencies.now(), value });
    void value.then((observation) => {
      if (observation.report?.fingerprint) this.fingerprints.set(machine.id, observation.report.fingerprint);
    }, () => {});
    return value;
  }

  /** The public lease plus its live forwards, when it holds any. */
  private view(lease: Reservation): PublicReservation {
    const forwarding = this.forwardings.get(lease.id);
    return { ...publicReservation(lease), ...(forwarding === undefined ? {} : { forwarding: forwarding.view() }) };
  }

  /** Every reservation for this worker id or its last confirmed physical identity. */
  reservationsFor(machine: Machine): PublicReservation[] {
    this.expire();
    const fingerprint = this.fingerprints.get(machine.id);
    return [...this.reservations.values()]
      .filter((lease) => lease.machineId === machine.id || (fingerprint !== undefined && lease.fingerprint === fingerprint))
      .map((lease) => this.view(lease));
  }

  /** A managed run's reservation uses its operation id, which links the operation to its worker. */
  reservationById(id: string): PublicReservation | undefined {
    const lease = this.reservations.get(id);
    return lease ? this.view(lease) : undefined;
  }

  /** Synchronous: call immediately before writing changed worker settings. */
  assertUnreserved(machine: Machine, action: string): void {
    const held = this.reservationsFor(machine)[0];
    if (held) throw new FleetError('machineBusy', `${machine.id} is reserved by ${held.owner} for ${held.label}. ${action} after that work is released.`);
  }

  /**
   * A route or remote-folder change must not strand running work or its
   * reservation. A remote-folder change also needs the current folder's job
   * lock verified free: the lock lives there, so a second folder would admit
   * a second job on the same computer.
   */
  async assertReconfigurable(machine: Machine, change: { readonly root: boolean }): Promise<void> {
    this.assertUnreserved(machine, 'Change its connection or remote folder');
    if (!change.root) return;
    const { report } = await this.inspect(machine, true);
    if (!report?.complete) throw new FleetError('machineBusy', `Can't confirm ${machine.id}'s job lock is free, so its remote folder was kept. Bring it online and try again.`);
    if (!this.remoteLocksFree(report)) throw new FleetError('machineBusy', `${machine.id} has a job lock in its current remote folder (${report.lock.state}), so the folder was kept.`);
  }

  /** Drops cached observations after a worker's settings change or it is removed. */
  forget(machineId: string): void {
    this.observations.delete(machineId);
    this.fingerprints.delete(machineId);
    this.maintenance.delete(machineId);
  }

  /** Read-only check of a candidate worker that need not be registered. Never cached. */
  async probe(candidate: Machine): Promise<ProbeResult> {
    const registered = this.dependencies.machines().filter((machine) => machine.id !== candidate.id);
    const [observation, local, known] = await Promise.all([
      this.dependencies.inspect(candidate),
      this.dependencies.localFingerprint().catch(() => undefined),
      Promise.all(registered.map(async (machine) => ({ machine, observation: await this.inspect(machine, false) }))),
    ]);
    const fingerprint = observation.report?.fingerprint;
    const sameAs = fingerprint === undefined ? undefined : known.find((entry) => entry.observation.report?.fingerprint === fingerprint)?.machine.id;
    return { observation, dispatchingComputer: fingerprint !== undefined && fingerprint === local, ...(sameAs === undefined ? {} : { sameAs }) };
  }

  async state(fresh = false): Promise<unknown> {
    const local = await this.dependencies.localFingerprint();
    const observations = await Promise.all(this.dependencies.machines().map((machine) => this.inspect(machine, fresh)));
    this.expire();
    return {
      protocolVersion: 1,
      coordinatorPid: process.pid,
      observedAt: new Date(this.dependencies.now()).toISOString(),
      workers: observations.map(({ machine, report, recent, error, observedAt }) => {
        const assignments = report?.fingerprint ? this.claims(report.fingerprint) : [];
        const used = report?.fingerprint ? this.capacityUsed(report.fingerprint, report) : assignments.length;
        const reservation = assignments.find((lease) => lease.claim?.mode !== 'shared');
        const decision = report ? evaluatePreflight(report, machine, undefined, { ignoreHeavyProcesses: false, nowEpoch: this.dependencies.now() / 1000 }) : undefined;
        const refusals = decision ? decision.refusals.map((f) => f.message) : [error ?? 'No complete observation'];
        if (report?.fingerprint === local) refusals.push('This is the dispatching computer.');
        if (reservation) refusals.push(`Reserved by ${reservation.owner}: ${reservation.label} (${reservation.state}).`);
        if (!reservation && used >= machine.limits.maxConcurrentJobs) refusals.push('All ordinary job slots are occupied.');
        return {
          id: machine.id, aliases: machine.aliases, description: machine.description,
          observedAt, available: refusals.length === 0, reasons: refusals,
          warnings: decision?.warnings.map((finding) => finding.message) ?? [],
          assignments: assignments.map((lease) => this.view(lease)),
          capacity: { limit: machine.limits.maxConcurrentJobs, used, free: reservation || report?.lock.state !== 'free' ? 0 : Math.max(0, machine.limits.maxConcurrentJobs - used), draining: assignments.some((lease) => lease.claim?.mode === 'drain'), e2e: { limit: e2eLimit(machine), used: report?.fingerprint ? this.e2eUsed(report.fingerprint, report) : 0 } },
          ...(report ? { health: { ...report, tools: Object.fromEntries(report.tools) } } : {}),
          ...(report ? { memoryAssessment: assessMemory(report) } : {}),
          ...(this.maintenance.has(machine.id) ? { maintenance: this.maintenance.get(machine.id) } : {}),
          ...(recent ? { recentJobs: recent.jobs, caches: recent.caches, jobsKiB: recent.jobsKiB } : {}),
          ...(reservation ? { reservation: this.view(reservation) } : {}),
        };
      }),
      reservations: [...this.reservations.values()].map((lease) => this.view(lease)),
    };
  }

  get maintenanceInProgress(): boolean { return this.maintenancePending > 0; }

  /** Foreground only: inspection is read-only unless an exact stale job is proven. */
  async maintain(machineId: string, onDiskSpaceProblem?: DiskSpaceProblemHandler): Promise<MaintenanceResult> {
    const machine = this.dependencies.machines().find((candidate) => candidate.id === machineId);
    if (!machine) throw new FleetError('usage', `Unknown worker: ${machineId}`);
    const local = await this.dependencies.localFingerprint();
    const candidates = this.managedRecoveryCandidates(machine);
    const observation = await this.inspect(machine, true, candidates.length ? this.recoveryJobIds(candidates) : undefined);
    const report = observation.report;
    let cleanup: MaintenanceResult['cleanup'] = { status: 'not-needed' };
    const save = (): MaintenanceResult => {
      const result: MaintenanceResult = { machineId, observedAt: observation.observedAt, cleanup,
        ...(report ? { memory: assessMemory(report) } : {}) };
      this.maintenance.set(machineId, result);
      return result;
    };
    // No await between this ownership/configuration check and reserving the
    // physical worker. External leases remain protected even after expiry.
    if (!report?.complete || !report.fingerprint || report.fingerprint === local || !this.destinationIsCurrent(machine)) {
      cleanup = { status: 'unverified' }; return save();
    }
    this.reconcileManaged(machine, candidates, report);
    if (this.held(report.fingerprint) || this.reservationsFor(machine).length) {
      cleanup = { status: 'reserved' }; return save();
    }
    const stale = report.lock.state === 'stale' ? report.lock : report.sharedLocks?.find((lock) => lock.state === 'stale');
    if (!stale || stale.state !== 'stale') return save();
    const jobId = stale.jobId;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(jobId) || !this.dependencies.cleanupStale) {
      cleanup = { status: 'unverified', jobId }; return save();
    }
    const lease: Reservation = { id: `maintenance-${randomBytes(12).toString('hex')}`, machineId,
      fingerprint: report.fingerprint, owner: 'The Fleet', label: `maintenance/${jobId}`, kind: 'managed',
      createdAt: new Date(this.dependencies.now()).toISOString(), expiresAt: null,
      tokenHash: hash(randomBytes(24).toString('hex')), state: 'active' };
    this.reservations.set(lease.id, lease);
    this.persist();
    this.maintenancePending += 1;
    try {
      const response = await this.dependencies.cleanupStale(machine, jobId);
      if (response.diskSpaceProblem) reportDiskSpaceProblem(onDiskSpaceProblem, response.diskSpaceProblem);
      cleanup = { status: response.result === 'cleared' ? 'cleared' : 'retained', jobId, result: response.result };
    } catch {
      cleanup = { status: 'unverified', jobId };
    } finally {
      // A disconnected cleanup/finalizer may still be running. Only a fresh
      // conclusive observation permits releasing its coordinator ownership.
      const check = await this.inspect(machine, true).catch(() => undefined);
      if (check?.report?.complete && check.report.fingerprint === lease.fingerprint && this.remoteLocksFree(check.report)) {
        this.reservations.delete(lease.id);
      } else {
        lease.state = 'unverified';
        if (cleanup.status === 'cleared') cleanup = { status: 'unverified', jobId };
      }
      this.maintenancePending -= 1;
      this.persist();
    }
    return save();
  }

  async reserve(
    owner: string,
    label: string,
    machineNames: readonly string[] | undefined,
    ttlSeconds = 180,
    claim: CapacityClaim = { mode: 'exclusive', resources: [] },
    onDiskSpaceProblem?: DiskSpaceProblemHandler,
    reservationStillRequested: () => boolean = () => true,
  ): Promise<unknown> {
    if (!owner.trim() || owner.length > 200 || !label.trim() || label.length > 300) throw new FleetError('usage', 'Supply a short owner and work label.');
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 15 || ttlSeconds > 3600) throw new FleetError('usage', 'Reservation duration must be 15–3600 seconds.');
    const local = await this.dependencies.localFingerprint();
    const machines = this.dependencies.machines();
    const selected = machineNames ? machineNames.map((name) => {
      const machine = machines.find((m) => m.id === name || m.aliases.includes(name) || m.transport.target === name);
      if (!machine) throw new FleetError('usage', `Unknown worker: ${name}`);
      return machine;
    }) : [...machines];
    if (machineNames === undefined) {
      const preferred = selected.findIndex(machine => machine.id === this.dependencies.preferredMachine?.());
      if (preferred > 0) selected.unshift(...selected.splice(preferred, 1));
    }
    const prepared = new Map<string, WorkerObservation>();
    if (machineNames === undefined) await Promise.all(selected.map(async machine => {
      await this.maintain(machine.id, onDiskSpaceProblem);
      prepared.set(machine.id, await this.inspect(machine, true));
    }));
    while (selected.length) {
      if (machineNames === undefined) selected.sort((a, b) => {
        const left = prepared.get(a.id)?.report, right = prepared.get(b.id)?.report;
        if (!left || !right) return left ? -1 : right ? 1 : 0;
        return compareWorkerMemory({ machine: a, report: left }, { machine: b, report: right });
      });
      const machine = selected.shift();
      if (!machine) break;
      if (machineNames !== undefined) {
        await this.maintain(machine.id, onDiskSpaceProblem);
        prepared.set(machine.id, await this.inspect(machine, true));
      }
      const observation = prepared.get(machine.id);
      // A settings editor may have changed or removed this worker while the
      // probe waited. No await may separate this check from granting ownership.
      if (!this.destinationIsCurrent(machine)) {
        throw new FleetError('machineBusy', `${machine.id}'s settings changed while it was being checked. Nothing was reserved.`);
      }
      const report = observation?.report;
      if (!report?.fingerprint || report.fingerprint === local) continue;
      if (claim.mode !== 'drain') {
        // Direct-SSH reservations do not create managed result archives.
        // Preserve their existing admission policy while managed state/runs
        // expose the supervisor's pending-output cap through common preflight.
        const decision = evaluatePreflight(report, machine, undefined, { ignoreHeavyProcesses: false, nowEpoch: this.dependencies.now() / 1000, checkPendingArtifacts: false });
        for (const finding of decision.refusals) if (finding.kind === 'disk') {
          reportDiskSpaceProblem(onDiskSpaceProblem, { machineId: machine.id, phase: 'admission', message: finding.message });
        }
        if (decision.refusals.length) continue;
      }
      const route = this.dependencies.route(machine);
      // No await between this ownership check and insertion: concurrent apps
      // cannot both reserve the same physical worker in this coordinator.
      const held = this.claims(report.fingerprint);
      if (claim.mode === 'drain') {
        // Drain is a barrier, not permission to run maintenance yet. The
        // caller must activate it after existing jobs finish; no SSH route
        // is handed out until a fresh idle check and no neighbouring lease.
        if (held.some((lease) => lease.claim?.mode !== 'shared')) continue;
      } else if (!this.accepts(report.fingerprint, claim, machine, report) || (claim.mode === 'exclusive' && !this.remoteIdle(report))) continue;
      // A client that disconnected during preflight cannot receive the token needed to release the claim.
      if (!reservationStillRequested()) throw new FleetError('cancelled', 'Cancelled before admission.');
      const token = randomBytes(24).toString('hex');
      const reservation: Reservation = {
        id: randomBytes(12).toString('hex'), machineId: machine.id, fingerprint: report.fingerprint,
        owner, label, kind: 'external', claim, createdAt: new Date(this.dependencies.now()).toISOString(),
        expiresAt: new Date(this.dependencies.now() + ttlSeconds * 1000).toISOString(), tokenHash: hash(token), state: 'active',
      };
      this.reservations.set(reservation.id, reservation);
      this.persist();
      return { reservation: publicReservation(reservation), token, ready: claim.mode !== 'drain', ...(claim.mode === 'drain' ? {} : { connection: this.connection(machine, route) }), health: { ...report, tools: Object.fromEntries(report.tools) }, note: 'Keep this reservation while using your own SSH. Expiry retains ownership until an explicit safe release.' };
    }
    throw new FleetError('machineBusy', 'No available worker. Check state for current load and owners.');
  }

  /** Supplies worker paths and the Docker context used for externally managed containers. */
  private connection(machine: Machine, route: AgentBridgeRoute): ReservationConnection {
    const dockerContext = machine.env['DOCKER_CONTEXT'];
    return { ...route, remoteRoot: machine.remoteRoot, pathPrepend: machine.pathPrepend,
      ...(dockerContext === undefined ? {} : { dockerContext }) }; // Other worker settings can contain credentials and remain private.
  }

  /**
   * Starts the loopback forwards owned by one external reservation.
   * Readiness is awaited here so the caller learns about an occupied local port
   * or an unreachable worker immediately; the session then stays with the
   * coordinator until stopForwarding, release or a service restart.
   */
  async forward(id: string, token: string, forwards: readonly PortForward[]): Promise<PublicForwarding> {
    const lease = this.authorized(id, token);
    if (this.releasing.has(id)) throw new FleetError('machineBusy', 'The reservation is being released.');
    if (lease.kind !== 'external' || lease.claim?.mode === 'drain') throw new FleetError('usage', 'Only an external reservation with a connection can own port forwards.');
    const machine = this.dependencies.machines().find((candidate) => candidate.id === lease.machineId);
    if (!machine) throw new FleetError('machineBusy', 'Worker configuration changed; preserve the reservation for recovery.');
    const spawn = this.dependencies.forward;
    if (!spawn) throw new FleetError('usage', 'This coordinator cannot start port forwards.');
    const existing = this.forwardings.get(id);
    if (existing !== undefined) {
      if (existing.forwards.length !== forwards.length || existing.forwards.some((held) =>
        !forwards.some((wanted) => held.localPort === wanted.localPort && held.remotePort === wanted.remotePort))) {
        throw new FleetError('machineBusy', 'Stop the reservation’s existing forwards before changing its ports.');
      }
      if (existing.view().state === 'connecting') return existing.start();
      return existing.view();
    }
    for (const [otherId, other] of this.forwardings) {
      if (otherId === id || other.view().state === 'stopped') continue;
      const clash = other.forwards.find((held) => forwards.some((wanted) => wanted.localPort === held.localPort));
      if (clash === undefined) continue;
      const owner = this.reservations.get(otherId);
      throw new FleetError('machineBusy', `Local port ${clash.localPort} is already forwarded by reservation ${otherId}${owner === undefined ? '' : ` (${owner.owner}: ${owner.label})`}.`);
    }
    // A settings editor may have changed the route while the owner decided; the
    // session must use the current pairing, like a run admitted after a probe.
    if (!this.destinationIsCurrent(machine)) throw new FleetError('machineBusy', `${machine.id}'s settings changed. Nothing was forwarded.`);
    const forwarding = new PortForwarding(forwards, () => spawn(machine, forwards), { ...this.dependencies.forwardingOptions, now: this.dependencies.now });
    this.forwardings.set(id, forwarding);
    try {
      return await forwarding.start();
    } catch (error) {
      if (this.forwardings.get(id) === forwarding) this.forwardings.delete(id);
      throw error;
    }
  }

  async stopForwarding(id: string, token: string): Promise<void> {
    this.authorized(id, token);
    await this.stopForwardsOf(id);
  }

  /** Service shutdown: ssh children would otherwise outlive the coordinator and hold the local ports. */
  async stopAllForwarding(): Promise<void> {
    await Promise.all([...this.forwardings.keys()].map((id) => this.stopForwardsOf(id)));
  }

  private async stopForwardsOf(id: string): Promise<void> {
    const forwarding = this.forwardings.get(id);
    if (forwarding === undefined) return;
    await forwarding.stop();
    if (this.forwardings.get(id) === forwarding) this.forwardings.delete(id);
  }

  async activate(id: string, token: string): Promise<unknown> {
    const lease = this.authorized(id, token);
    if (lease.claim?.mode !== 'drain') throw new FleetError('usage', 'Reservation is not draining.');
    const machine = this.dependencies.machines().find((candidate) => candidate.id === lease.machineId);
    if (!machine) throw new FleetError('machineBusy', 'Worker configuration changed.');
    const { report } = await this.inspect(machine, true);
    this.authorized(id, token);
    if (lease.claim?.mode !== 'drain' || this.releasing.has(id)) throw new FleetError('machineBusy', 'Reservation changed while checking the worker.');
    if (!this.destinationIsCurrent(machine) || !report || report.fingerprint !== lease.fingerprint || !this.remoteIdle(report)
      || this.claims(lease.fingerprint).some((other) => other.id !== id)) return { ready: false, reservation: publicReservation(lease) };
    lease.claim = { mode: 'exclusive', resources: lease.claim.resources };
    this.persist();
    return { ready: true, reservation: publicReservation(lease), connection: this.connection(machine, this.dependencies.route(machine)) };
  }

  renew(id: string, token: string, ttlSeconds = 180): PublicReservation {
    const lease = this.authorized(id, token);
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 15 || ttlSeconds > 3600) throw new FleetError('usage', 'Reservation duration must be 15–3600 seconds.');
    lease.expiresAt = new Date(this.dependencies.now() + ttlSeconds * 1000).toISOString();
    lease.state = 'active';
    this.persist();
    return publicReservation(lease);
  }

  private authorized(id: string, token: string): Reservation {
    const lease = this.reservations.get(id);
    if (!lease || lease.tokenHash !== hash(token)) throw new FleetError('usage', 'Reservation not found or token does not match.');
    return lease;
  }

  /** Shared by managed jobs and external reservations after their awaited checks. */
  private destinationIsCurrent(machine: Machine): boolean {
    try {
      const current = this.dependencies.machines().find((candidate) => candidate.id === machine.id);
      return current !== undefined && current.remoteRoot === machine.remoteRoot
        && JSON.stringify(current.largeScratch) === JSON.stringify(machine.largeScratch)
        && current.limits.maxConcurrentJobs === machine.limits.maxConcurrentJobs
        && e2eLimit(current) === e2eLimit(machine)
        && current.transport.target === machine.transport.target
        && current.transport.configPath === machine.transport.configPath;
    } catch { return false; }
  }

  async release(id: string, token: string, workStopped = false): Promise<void> {
    const lease = this.authorized(id, token);
    if (lease.claim?.mode === 'drain') { this.reservations.delete(id); this.persist(); return; }
    const machine = this.dependencies.machines().find((m) => m.id === lease.machineId);
    if (!machine) throw new FleetError('machineBusy', 'Worker configuration changed; preserve the reservation for recovery.');
    const { report } = await this.inspect(machine, true);
    // A shared external client explicitly attests it has stopped its own SSH
    // work; neighbours may still be busy. Legacy clients keep the idle gate.
    if (!report?.complete || report.fingerprint !== lease.fingerprint || (!(lease.claim?.mode === 'shared' && workStopped) && !this.remoteIdle(report))) {
      throw new FleetError('machineBusy', 'Worker is busy or its state is unverified. Stop your work and inspect it before releasing.');
    }
    // Forwards end with their owner, and only after ssh has exited: a released
    // worker must not still be reachable through this computer's loopback.
    this.authorized(id, token);
    if (this.releasing.has(id)) throw new FleetError('machineBusy', 'The reservation is being released.');
    this.releasing.add(id); // Keep new forwards out while SSH is closing and before the reservation disappears.
    try {
      await this.stopForwardsOf(id);
      this.reservations.delete(id);
      this.persist();
    } finally {
      this.releasing.delete(id);
    }
  }

  /** Recovers one expired external claim after the operator verifies its work stopped. */
  async recoverExpiredExternal({ id, owner, machineId, fingerprint }: Pick<Reservation, 'id' | 'owner' | 'machineId' | 'fingerprint'>): Promise<PublicReservation> {
    const lease = this.reservations.get(id);
    if (!lease || lease.kind !== 'external' || lease.owner !== owner || lease.machineId !== machineId || lease.fingerprint !== fingerprint) {
      throw new FleetError('usage', 'No external reservation matches that ID, owner and ship.');
    }
    const { expiresAt, claim } = lease;
    if (expiresAt === null || Date.parse(expiresAt) > this.dependencies.now()) {
      throw new FleetError('machineBusy', 'The reservation has not expired.');
    }
    const machine = this.dependencies.machines().find((candidate) => candidate.id === machineId);
    if (!machine) throw new FleetError('machineBusy', 'Worker configuration changed.');
    const { report } = await this.inspect(machine, true);
    // An abandoned managed lock can protect an oversized report after the process
    // is gone. It must not keep an unrelated expired desktop claim alive too.
    const processFree = report?.complete && report.admissionFree === true && report.lock.state === 'free'
      && !report.heavy.length && !report.managedPgids?.length
      && (report.sharedLocks ?? []).every(lock => lock.state === 'stale' && lock.jobId !== '-');
    if (!report || !this.destinationIsCurrent(machine) || report.fingerprint !== fingerprint
      || !(this.mode === 'serve' ? processFree : this.remoteIdle(report))) {
      throw new FleetError('machineBusy', 'The ship is busy or its identity could not be verified.');
    }
    if (this.reservations.get(id) !== lease || lease.expiresAt !== expiresAt || lease.claim !== claim) {
      throw new FleetError('machineBusy', 'The reservation changed while the ship was being checked.');
    }
    if (this.releasing.has(id) || this.forwardings.has(id)) {
      throw new FleetError('machineBusy', 'The reservation still owns a forwarding session.');
    }
    // Recheck after the probe and persist in the same turn as the decision.
    this.reservations.delete(id);
    try {
      this.persist();
    } catch (error) {
      this.reservations.set(id, lease);
      throw error;
    }
    return publicReservation({ ...lease, state: 'expired' });
  }

  async runOne(owner: string, operation: string, request: RunRequest): Promise<RunResult | null> {
    if (!request.preflightReport) await this.maintain(request.machine.id, request.io.onDiskSpaceProblem);
    const observation = request.preflightReport ? { report: request.preflightReport } : await this.inspect(request.machine, true);
    const fingerprint = observation.report?.fingerprint;
    if (!fingerprint) throw new FleetError('machineCheckRefused', 'Worker identity is not confirmed.');
    const claim = profileClaim(getProfile(request.project, request.profileName, request.extraArgs), request.machine);
    if (!this.accepts(fingerprint, claim, request.machine, observation.report)) return null;
    const jobId = makeJobId(request.project.manifest.id, request.profileName, new Date(this.dependencies.now()));
    const lease: Reservation = { id: operation, machineId: request.machine.id, fingerprint, owner,
      label: `${request.project.manifest.id}/${request.profileName}`, kind: 'managed', claim, jobId,
      createdAt: new Date(this.dependencies.now()).toISOString(), expiresAt: null,
      tokenHash: hash(randomBytes(24).toString('hex')), state: 'active' };
    this.reservations.set(lease.id, lease);
    this.persist();
    // Settings edits check reservations synchronously before writing. Checking
    // the saved route and folder here, after inserting this lease and with no
    // await in between, means superseded settings cannot take a second lock.
    if (!this.destinationIsCurrent(request.machine)) {
      this.reservations.delete(lease.id);
      this.persist();
      throw new FleetError('machineBusy', `${request.machine.id}'s settings changed while this run was starting. Nothing was started.`);
    }
    let result: RunResult | undefined;
    let neverStarted = false;
    try {
      result = await this.dependencies.execute({ ...request, jobId });
      return result;
    } catch (error) {
      neverStarted = error instanceof RunNotStartedError;
      throw error;
    } finally {
      if (neverStarted || (result && (result.admission === 'refused' || result.receipt.remote.lockReleased))) {
        this.reservations.delete(lease.id);
      } else {
        // A validation failure may happen before remote admission. Only a
        // fresh conclusive probe can clear ownership after an exception.
        const check = await this.inspect(request.machine, true).catch(() => undefined);
        if (check?.report?.complete && check.report.fingerprint === fingerprint && this.remoteIdle(check.report)) this.reservations.delete(lease.id);
        else lease.state = 'unverified';
      }
      this.observations.delete(request.machine.id);
      this.persist();
    }
  }

  private managedRecoveryCandidates(machine: Machine): Reservation[] {
    return [...this.reservations.values()].filter((lease) =>
      lease.kind === 'managed' && lease.state === 'unverified' && lease.machineId === machine.id);
  }

  private recoveryJobIds(candidates: readonly Reservation[]): string[] {
    return [...new Set(candidates.flatMap((lease) => lease.jobId ? [lease.jobId] : []))];
  }

  private reconcileManaged(machine: Machine, candidates: readonly Reservation[], report: PreflightReport): string[] {
    if (!report.complete || !report.fingerprint || !this.destinationIsCurrent(machine)) return [];
    const locks = [report.lock, ...(report.sharedLocks ?? [])];
    const idle = this.remoteIdle(report);
    // An old claim may predate a worker folder or its folder may have been
    // pruned. Infer absence only when the kernel guard is free and the lock
    // listing has no running or unknown owner. Keep a matching stale lock:
    // it might still own a finalizer or the last copy of the job's artifacts.
    const absenceIsConclusive = report.admissionFree === true &&
      locks.every((lock) => lock.state === 'free' || (lock.state === 'stale' && lock.jobId !== '-'));
    const released = candidates.filter((lease) => {
      if (lease.fingerprint !== report.fingerprint || this.reservations.get(lease.id) !== lease || lease.state !== 'unverified') return false;
      if (idle) return true;
      const jobId = lease.jobId;
      return Boolean(jobId && /^[a-z0-9][a-z0-9-]*$/.test(jobId) &&
        locks.every((lock) => lock.state === 'free' || (lock.jobId !== '-' && lock.jobId !== jobId)) &&
        (absenceIsConclusive || report.releasedJobs?.includes(jobId)));
    });
    if (!released.length) return [];
    for (const lease of released) this.reservations.delete(lease.id);
    try {
      this.persist();
    } catch (error) {
      for (const lease of released) this.reservations.set(lease.id, lease);
      throw error;
    }
    return released.map((lease) => lease.id);
  }

  async recoverManaged(machineId?: string): Promise<string[]> {
    const workers = this.dependencies.machines().filter((machine) => machineId === undefined || machine.id === machineId);
    if (machineId !== undefined && !workers.length) {
      throw new FleetError('usage', `Unknown worker: ${machineId}`);
    }
    const local = await this.dependencies.localFingerprint();
    // Probe once per worker, in parallel. A 120-second client request
    // previously queued two SSH commands in series for each stale claim.
    return (await Promise.all(workers.map(async (machine) => {
      const candidates = this.managedRecoveryCandidates(machine);
      if (!candidates.length) return [];
      const { report } = await this.inspect(machine, true, this.recoveryJobIds(candidates));
      return report && report.fingerprint !== local ? this.reconcileManaged(machine, candidates, report) : [];
    }))).flat();
  }
}
