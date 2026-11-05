// The Fleet local API. One user-private Unix socket owns execution and
// reservations; CLI processes, Agent Bridge and the desktop app are clients of
// this instance.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { parseClaim } from '../run/capacity.ts';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { Writable } from 'node:stream';
import { Coordinator } from './coordinator.ts';
import { main, defaultContext } from '../cli/main.ts';
import { loadMachines, loadProject, type LoadedProject } from '../registry.ts';
import { resolveRunPaths, ensurePrivateDir, expandHome, type StatePaths } from '../paths.ts';
import { getProfile, Interrupts, type RunRequest, type RunResult } from '../run/runJob.ts';
import { defaultMachineNames, orderedMachines, runOnOrderedMachines } from '../run/orderedMachines.ts';
import { parseManifest } from '../schema/manifest.ts';
import type { Machine } from '../schema/machines.ts';
import { IDENTIFIER_PATTERN } from '../schema/validate.ts';
import { FleetError, usageError } from '../errors.ts';
import { SshTransport } from '../transport/sshTransport.ts';
import type { Transport } from '../transport/transport.ts';
import { defaultAgentBridgeConfigPath, loadAgentBridgeRoute, type AgentBridgeRoute } from '../transport/agentBridgeConfig.ts';
import { ApiError } from './apiError.ts';
import { addMachine, checkPairing, configurationView, editMachine, pairingsView, removeMachine, type ConfigurationDependencies } from './configuration.ts';
import { planView, projectsView, recordRun, runDetailView, runsView } from './catalog.ts';
import type { DiskSpaceProblemHandler } from '../run/diskSpace.ts';
import { operationDiskNotifier, sendAgentBridgeDiskNotification, type DiskSpaceNotificationSender } from './diskNotifications.ts';
import { editControllerConfiguration } from './controllerConfiguration.ts';
import { resolveProject } from './projectResolution.ts';

const VERSION: string = (() => {
  try { return String(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version); }
  catch { return 'unknown'; }
})();

interface Operation {
  id: string;
  owner: string;
  kind: 'command' | 'submit' | 'run';
  label: string;
  project?: string;
  profile?: string;
  createdAt: number;
  finishedAt?: number;
  /** Detached work is not cancelled when its client stops polling; it still ends at its own deadline or on explicit cancel. */
  detached: boolean;
  jobIds: string[];
  status: 'running' | 'complete';
  exitCode?: number;
  output: string;
  offset: number;
  lastSeen: number;
  cancelRequested: boolean;
  forceDisconnectRequested?: boolean;
  interrupts: Interrupts;
  onDiskSpaceProblem: DiskSpaceProblemHandler;
}

type OperationMeta = Pick<Operation, 'kind' | 'label' | 'detached'> & Partial<Pick<Operation, 'project' | 'profile'>>;

export interface ApiOptions {
  /** Explicit in production; fixture servers default to no native side effects. */
  readonly notifyDiskSpace?: DiskSpaceNotificationSender;
  readonly transportFor?: (machine: Machine) => Transport;
  readonly route?: (target: string, configPath: string | undefined) => AgentBridgeRoute;
  readonly bridgeConfigPath?: () => string;
  /** Unpolled, non-detached operations are cancelled after this long. */
  readonly abandonAfterMs?: number;
  readonly sweepIntervalMs?: number;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw usageError('Expected a JSON object.');
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max = 1000): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f]/.test(value)) throw usageError(`Invalid ${name}.`);
  return value;
}
function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 200 || value.some((v) => typeof v !== 'string' || v.length > 10000 || v.includes('\0'))) throw usageError(`Invalid ${name}.`);
  return value as string[];
}
function flag(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw usageError(`Invalid ${name}.`);
  return value;
}
async function body(request: IncomingMessage, allowEmpty = false): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += buffer.length;
    if (size > 2 * 1024 * 1024) throw usageError('Request is larger than 2 MiB.');
    parts.push(buffer);
  }
  let value: unknown;
  if (allowEmpty && size === 0) return {};
  try { value = JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw usageError('Request body is not valid JSON.'); }
  return record(value);
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
export function serviceSocket(paths: StatePaths): string { return join(paths.home, 'service.sock'); }

/** A reusable stored recipe is optional; this request exists only for this run. */
export function inlineProject(input: Record<string, unknown>, cwd: string): { project: LoadedProject; sourceRoot: string; profileName: string } {
  if (input['manifest'] !== undefined) {
    for (const key of Object.keys(input)) if (!['source', 'manifest', 'profile'].includes(key)) throw usageError(`Unknown full-manifest request field: ${key}`);
    const manifest = parseManifest(input['manifest'], 'one-time manifest');
    const profileName = text(input['profile'], 'profile', 48);
    const sourceRoot = resolve(cwd, expandHome(text(input['source'], 'source')));
    const project: LoadedProject = { manifest, entry: { schemaVersion: 1, id: manifest.id, manifestPath: 'one-time manifest', sourceRoot, registeredAt: new Date().toISOString() } };
    getProfile(project, profileName);
    return { project, sourceRoot, profileName };
  }
  const id = text(input['project'] ?? 'ad-hoc', 'project', 80);
  const sourceRoot = resolve(cwd, expandHome(text(input['source'], 'source')));
  const profileName = 'request';
  const manifest = parseManifest({ schemaVersion: 1, id,
    sync: { include: strings(input['files'], 'files') },
    profiles: { [profileName]: {
      kind: input['kind'] ?? 'test', description: input['description'] ?? 'One-time agent request',
      argv: strings(input['command'], 'command'), timeoutMinutes: input['timeoutMinutes'],
      ...(input['prepare'] === undefined ? {} : { prepare: input['prepare'] }),
      ...(input['requires'] === undefined ? {} : { requires: input['requires'] }),
      ...(input['success'] === undefined ? {} : { success: input['success'] }),
      ...(input['artifacts'] === undefined ? {} : { artifacts: input['artifacts'] }),
      ...(input['env'] === undefined ? {} : { env: input['env'] }),
      ...(input['cache'] === undefined ? {} : { cache: input['cache'] }),
      ...(input['sourceTransfer'] === undefined ? {} : { sourceTransfer: input['sourceTransfer'] }),
    } },
  }, 'one-time request');
  return { project: { manifest, entry: { schemaVersion: 1, id, manifestPath: 'one-time request', sourceRoot, registeredAt: new Date().toISOString() } }, sourceRoot, profileName };
}

function normalizedArguments(argv: string[], cwd: string): string[] {
  const result = [...argv];
  for (let i = 0; i < result.length; i += 1) {
    if ((i === 1 && (result[0] === 'register' || result[0] === 'validate')) || result[i - 1] === '--source') {
      result[i] = resolve(cwd, expandHome(result[i] ?? ''));
    }
  }
  // Keep an omitted worker selector omitted: runCommand distinguishes automatic
  // load-aware placement from an explicitly ordered --machines request.
  return result;
}

function commandLabel(argv: readonly string[]): Pick<OperationMeta, 'label' | 'project' | 'profile'> {
  if (argv[0] === 'run' && argv[1] && argv[2] && !argv[1].startsWith('-') && !argv[2].startsWith('-')) {
    return { label: `${argv[1]}/${argv[2]}`, project: argv[1], profile: argv[2] };
  }
  return { label: `the-fleet ${argv.join(' ')}`.slice(0, 200) };
}

function lastLine(output: string): string | null {
  const lines = output.slice(-4000).split('\n').map((line) => line.trim()).filter(Boolean);
  const line = lines.at(-1);
  return line === undefined ? null : line.slice(0, 300);
}

function failure(error: unknown): { status: number; value: Record<string, unknown> } {
  if (error instanceof ApiError) return { status: error.status, value: { error: error.message, code: error.code, ...error.extra } };
  const busy = error instanceof FleetError && error.kind === 'machineBusy';
  return {
    status: busy ? 409 : 400,
    value: {
      error: error instanceof Error ? error.message : 'Request failed',
      exitCode: error instanceof FleetError ? error.exitCode : 2,
      code: busy ? 'busy' : 'invalid',
      ...(error instanceof FleetError && error.details.length ? { details: error.details } : {}),
    },
  };
}

export function startApi(paths: StatePaths, coordinator = new Coordinator(paths), options: ApiOptions = {}) {
  const operations = new Map<string, Operation>();
  const pending = new Set<Promise<void>>();
  const startedAt = new Date().toISOString();
  const transportFor = options.transportFor ?? ((machine: Machine) => SshTransport.forMachine(machine));
  const configuration: ConfigurationDependencies = {
    coordinator,
    route: options.route ?? loadAgentBridgeRoute,
    bridgeConfigPath: options.bridgeConfigPath ?? (() => defaultAgentBridgeConfigPath()),
  };
  const abandonAfterMs = options.abandonAfterMs ?? 75_000;
  let stopping = false;

  const diskNotifier = (id: string) => operationDiskNotifier(id, options.notifyDiskSpace,
    (error) => process.stderr.write(`The Fleet disk notification failed: ${error instanceof Error ? error.message : String(error)}\n`));

  function publicOperation(operation: Operation): Record<string, unknown> {
    const lease = coordinator.reservationById(operation.id);
    return {
      id: operation.id, owner: operation.owner, kind: operation.kind, label: operation.label,
      project: operation.project ?? null, profile: operation.profile ?? null,
      status: operation.status, exitCode: operation.exitCode ?? null,
      createdAt: new Date(operation.createdAt).toISOString(),
      finishedAt: operation.finishedAt === undefined ? null : new Date(operation.finishedAt).toISOString(),
      detached: operation.detached, cancelRequested: operation.cancelRequested, jobIds: operation.jobIds,
      machineId: lease?.machineId ?? null, lastLine: lastLine(operation.output),
    };
  }

  function createOperation(owner: string, meta: OperationMeta, execute: (operation: Operation, output: Writable) => Promise<number>): Operation {
    const id = randomBytes(12).toString('hex');
    const operation: Operation = { id, owner, ...meta, createdAt: Date.now(), jobIds: [], status: 'running', output: '', offset: 0,
      lastSeen: Date.now(), cancelRequested: false, interrupts: new Interrupts(), onDiskSpaceProblem: diskNotifier(id) };
    operations.set(operation.id, operation);
    const output = new Writable({ write(chunk, _encoding, next) {
      operation.output += String(chunk);
      if (operation.output.length > 512 * 1024) {
        const remove = operation.output.length - 512 * 1024;
        operation.output = operation.output.slice(remove); operation.offset += remove;
      }
      next();
    } });
    const completion = execute(operation, output).then((exitCode) => { operation.exitCode = exitCode; }).catch((error: unknown) => {
      output.write(`${error instanceof Error ? error.message : 'Operation failed'}\n`);
      operation.exitCode = error instanceof FleetError ? error.exitCode : 1;
    }).finally(() => {
      operation.status = 'complete';
      operation.finishedAt = Date.now();
      // Finished output is bounded too; durable job details remain in receipts.
      const finished = [...operations.values()].filter((op) => op.status === 'complete');
      for (const old of finished.slice(0, Math.max(0, finished.length - 100))) operations.delete(old.id);
      pending.delete(completion);
    });
    pending.add(completion);
    return operation;
  }

  /** The one shared admission gate, used by commands, one-time requests and profile runs alike. */
  function managedRunner(operation: Operation) {
    return async (run: RunRequest): Promise<RunResult | null> => {
      if (operation.cancelRequested) throw new FleetError('cancelled', 'Cancelled before admission.');
      const result = await coordinator.runOne(operation.owner, operation.id, run);
      if (result) {
        operation.jobIds.push(result.receipt.jobId);
        try { recordRun(paths, result, { operationId: operation.id, owner: operation.owner }); }
        catch { /* History pointers are best effort; the receipt stays authoritative. */ }
      }
      return result;
    };
  }

  function startCommand(owner: string, argv: string[], runPaths: StatePaths, meta: OperationMeta): Operation {
    return createOperation(owner, meta, async (op, output) =>
      main(argv, { ...defaultContext(), transportFor, paths: runPaths, stdout: output, stderr: output, interrupts: op.interrupts, runOne: managedRunner(op),
        selectionUsage: (machine, report) => coordinator.selectionUsage(machine, report),
        onDiskSpaceProblem: op.onDiskSpaceProblem,
        beforePreflight: async (machine) => { await coordinator.maintain(machine.id, op.onDiskSpaceProblem); } }));
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = request.method ?? 'GET';
    if (method === 'GET' && path === '/v1/health') return json(response, 200, { application: 'The Fleet', protocolVersion: 1, pid: process.pid, version: VERSION, startedAt });
    if (method === 'GET' && path === '/v1/state') return json(response, 200, await coordinator.state(url.searchParams.get('fresh') === '1'));
    if (method === 'POST' && path === '/v1/maintenance') {
      if (stopping) throw new FleetError('machineBusy', 'The Fleet is stopping.');
      const input = await body(request);
      for (const key of Object.keys(input)) if (key !== 'machine') throw usageError(`Unknown maintenance field: ${key}`);
      const ids = input['machine'] === undefined ? loadMachines(paths).machines.map((machine) => machine.id) : [text(input['machine'], 'machine', 64)];
      const workers = [];
      const onDiskSpaceProblem = diskNotifier(randomBytes(12).toString('hex'));
      for (const id of ids) workers.push(await coordinator.maintain(id, onDiskSpaceProblem));
      return json(response, 200, { workers });
    }
    if (method === 'POST' && path === '/v1/recover') {
      const machine = url.searchParams.get('machine') ?? undefined;
      if (machine !== undefined && !IDENTIFIER_PATTERN.test(machine)) throw usageError('Invalid worker name.');
      return json(response, 200, { released: await coordinator.recoverManaged(machine) });
    }
    if (method === 'POST' && path === '/v1/reservations') {
      if (stopping) throw new FleetError('machineBusy', 'The Fleet is stopping.');
      const input = await body(request);
      return json(response, 200, await coordinator.reserve(text(input['owner'], 'owner', 200), text(input['label'], 'label', 300), input['machines'] === undefined ? undefined : strings(input['machines'], 'machines'), input['ttlSeconds'] === undefined ? 180 : Number(input['ttlSeconds']), input['claim'] === undefined ? undefined : parseClaim(input['claim']), diskNotifier(randomBytes(12).toString('hex'))));
    }
    if (method === 'POST' && (path === '/v1/renew' || path === '/v1/release' || path === '/v1/activate')) {
      const input = await body(request), id = text(input['id'], 'id'), token = text(input['token'], 'token');
      if (path === '/v1/renew') return json(response, 200, coordinator.renew(id, token, input['ttlSeconds'] === undefined ? 180 : Number(input['ttlSeconds'])));
      if (path === '/v1/activate') return json(response, 200, await coordinator.activate(id, token));
      if (input['workStopped'] !== undefined && typeof input['workStopped'] !== 'boolean') throw usageError('workStopped must be boolean.');
      await coordinator.release(id, token, input['workStopped'] === true); return json(response, 200, { released: true });
    }

    // ---- worker settings (machines.json) and Agent Bridge pairings
    if (method === 'GET' && path === '/v1/config') return json(response, 200, configurationView(paths));
    if (method === 'PUT' && path === '/v1/config/controller') {
      if (stopping) throw new FleetError('machineBusy', 'The Fleet is stopping.');
      editControllerConfiguration(paths, await body(request));
      return json(response, 200, configurationView(paths));
    }
    if (method === 'GET' && path === '/v1/pairings') return json(response, 200, pairingsView(paths, configuration));
    if (method === 'POST' && path === '/v1/pairings/check') return json(response, 200, await checkPairing(paths, configuration, await body(request)));
    if (method === 'POST' && path === '/v1/machines') {
      if (stopping) throw new FleetError('machineBusy', 'The Fleet is stopping.');
      return json(response, 200, addMachine(paths, configuration, await body(request)));
    }
    const machineMatch = /^\/v1\/machines\/([^/]+)$/.exec(path);
    if (machineMatch) {
      const id = decodeURIComponent(machineMatch[1] ?? '');
      if (!IDENTIFIER_PATTERN.test(id)) throw usageError('Invalid worker name.');
      if (stopping) throw new FleetError('machineBusy', 'The Fleet is stopping.');
      if (method === 'PUT') return json(response, 200, await editMachine(paths, configuration, id, await body(request)));
      if (method === 'DELETE') return json(response, 200, removeMachine(paths, configuration, id, text(url.searchParams.get('revision'), 'revision', 100)));
      return json(response, 405, { error: 'Method not supported.', code: 'invalid' });
    }

    // ---- registered projects and finished runs
    if (method === 'GET' && path === '/v1/projects') return json(response, 200, projectsView(paths));
    if (method === 'POST' && path === '/v1/projects/resolve') return json(response, 200, await resolveProject(paths, await body(request)));
    const projectMatch = /^\/v1\/projects\/([^/]+)\/(plan|run)$/.exec(path);
    if (projectMatch && method === 'POST') {
      const projectId = decodeURIComponent(projectMatch[1] ?? '');
      if (!IDENTIFIER_PATTERN.test(projectId)) throw usageError('Invalid project name.');
      const input = await body(request);
      if (projectMatch[2] === 'plan') return json(response, 200, await planView(paths, projectId, input));
      if (stopping) throw new FleetError('machineBusy', 'The Fleet is stopping.');
      for (const key of Object.keys(input)) if (!['profile', 'machine', 'machines', 'owner', 'detached'].includes(key)) throw usageError(`Unknown run field: ${key}`);
      const profileName = text(input['profile'], 'profile', 48);
      const profile = getProfile(loadProject(paths, projectId), profileName);
      if (profile.blocked !== undefined) throw usageError(`${projectId}/${profileName} is blocked: ${profile.blocked}`);
      if (input['machine'] !== undefined && input['machines'] !== undefined) throw usageError('Use machine or machines, not both.');
      const pinned = input['machine'] === undefined ? [] : ['--machine', text(input['machine'], 'machine', 64)];
      const ordered = input['machines'] === undefined ? [] : ['--machines', strings(input['machines'], 'machines').join(',')];
      const cwd = homedir();
      const argv = normalizedArguments(['run', projectId, profileName, ...pinned, ...ordered], cwd);
      const operation = startCommand(text(input['owner'] ?? 'local-client', 'owner', 200), argv, resolveRunPaths(paths),
        { kind: 'run', label: `${projectId}/${profileName}`, project: projectId, profile: profileName, detached: flag(input['detached'], 'detached') });
      return json(response, 202, { operationId: operation.id, operation: publicOperation(operation) });
    }
    if (method === 'GET' && path === '/v1/runs') {
      const limit = Number(url.searchParams.get('limit') ?? 100);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw usageError('limit must be 1–500.');
      const project = url.searchParams.get('project');
      return json(response, 200, runsView(paths, { limit, ...(project ? { project } : {}) }));
    }
    const runMatch = /^\/v1\/runs\/([^/]+)$/.exec(path);
    if (runMatch && method === 'GET') {
      const tail = Number(url.searchParams.get('tail') ?? 256 * 1024);
      if (!Number.isInteger(tail) || tail < 1024 || tail > 1024 * 1024) throw usageError('tail must be 1 KiB–1 MiB.');
      return json(response, 200, runDetailView(paths, decodeURIComponent(runMatch[1] ?? ''), tail));
    }

    // ---- operations
    if (method === 'GET' && path === '/v1/operations') {
      return json(response, 200, { operations: [...operations.values()].sort((left, right) => right.createdAt - left.createdAt).map(publicOperation) });
    }
    const match = /^\/v1\/operations\/([a-f0-9]{24})(\/cancel)?$/.exec(path);
    if (match) {
      const operation = operations.get(match[1] ?? '');
      if (!operation) return json(response, 404, { error: 'Operation is not retained. Inspect the durable job receipts.', code: 'not-found' });
      // Observers (such as a dashboard showing another client's job) read
      // without becoming its heartbeat, so abandoned work is still cancelled.
      if (match[2] || url.searchParams.get('observe') !== '1') operation.lastSeen = Date.now();
      if (match[2] && method === 'POST') {
        const input = await body(request, true);
        const forceDisconnect = flag(input['forceDisconnect'], 'forceDisconnect');
        // API retries mean "cancel", not a second Ctrl-C. Only an explicit
        // force request disconnects SSH; handle out-of-order requests too.
        if (operation.status === 'running') {
          if (!operation.cancelRequested) {
            operation.cancelRequested = true; operation.interrupts.trigger();
          }
          if (forceDisconnect && !operation.forceDisconnectRequested) {
            operation.forceDisconnectRequested = true; operation.interrupts.trigger();
          }
        }
        return json(response, 200, { cancellationRequested: true });
      }
      if (method !== 'GET') return json(response, 405, { error: 'Method not supported.', code: 'invalid' });
      const requestedOffset = Number(url.searchParams.get('offset') ?? 0);
      const offset = Number.isFinite(requestedOffset) ? Math.max(requestedOffset, operation.offset) : operation.offset;
      return json(response, 200, { ...publicOperation(operation), id: operation.id, owner: operation.owner, status: operation.status, exitCode: operation.exitCode,
        output: operation.output.slice(offset - operation.offset), nextOffset: operation.offset + operation.output.length,
        truncated: requestedOffset < operation.offset });
    }
    if (method === 'POST' && (path === '/v1/command' || path === '/v1/submit' || path === '/v1/submit/plan')) {
      if (stopping) throw new FleetError('machineBusy', 'The Fleet is stopping.');
      const input = await body(request);
      const owner = text(input['owner'] ?? 'local-client', 'owner', 200);
      const cwd = text(input['cwd'], 'cwd');
      if (!isAbsolute(cwd)) throw usageError('cwd must be absolute.');
      const detached = flag(input['detached'], 'detached');
      const requestedRunDirectory = input['runsDirectory'] === undefined ? undefined : text(input['runsDirectory'], 'runsDirectory');
      if (path === '/v1/submit' || path === '/v1/submit/plan') {
        const oneTime = inlineProject(record(input['request']), cwd);
        if (path === '/v1/submit/plan') return json(response, 200, await planView(paths, oneTime.project.manifest.id,
          { profile: oneTime.profileName, ...(input['machine'] === undefined ? {} : { machine: input['machine'] }) }, oneTime.project));
        const runPaths = resolveRunPaths(paths, requestedRunDirectory);
        const operation = createOperation(owner, { kind: 'submit', label: `${oneTime.project.manifest.id}/${oneTime.profileName}`, project: oneTime.project.manifest.id, profile: oneTime.profileName, detached }, async (op, output) => {
          const registry = loadMachines(paths);
          // A controller default is a preference; a manifest default is a
          // project pin. An explicit request keeps its own worker order.
          const names = input['machines'] === undefined
            ? (oneTime.project.manifest.defaultMachine === undefined ? defaultMachineNames(registry) : [oneTime.project.manifest.defaultMachine])
            : strings(input['machines'], 'machines');
          const result = await runOnOrderedMachines({ ...oneTime, paths: runPaths, machines: orderedMachines(registry, names), transportFor,
            automatic: input['machines'] === undefined && oneTime.project.manifest.defaultMachine === undefined,
            selectionUsage: (machine, report) => coordinator.selectionUsage(machine, report),
            extraArgs: [], ignoreHeavyProcesses: false, interrupts: op.interrupts, runOne: managedRunner(op),
            beforePreflight: async (machine) => { await coordinator.maintain(machine.id, op.onDiskSpaceProblem); },
            io: { stdout: output, stderr: output, status: (line) => { output.write(`fleet-runner: ${line}\n`); }, onDiskSpaceProblem: op.onDiskSpaceProblem } });
          return result.exitCode;
        });
        return json(response, 202, { operationId: operation.id });
      }
      const argv = normalizedArguments(strings(input['argv'], 'argv'), cwd);
      const runPaths = ['run', 'recover'].includes(argv[0] ?? '') ? resolveRunPaths(paths, requestedRunDirectory) : paths;
      const operation = startCommand(owner, argv, runPaths, { kind: 'command', ...commandLabel(argv), detached });
      return json(response, 202, { operationId: operation.id });
    }
    if (method === 'POST' && path === '/v1/stop') {
      if (coordinator.maintenanceInProgress || [...operations.values()].some((op) => op.status === 'running')) throw new FleetError('machineBusy', 'Jobs are still running. Cancel them before stopping The Fleet.');
      stopping = true; json(response, 200, { stopping: true }); server.close(); return;
    }
    json(response, 404, { error: 'Unknown API route.', code: 'unknown-route' });
  }

  const server = createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      const { status, value } = failure(error);
      if (!response.headersSent) json(response, status, value);
      else response.end();
    });
  });
  const abandon = setInterval(() => {
    for (const operation of operations.values()) if (operation.status === 'running' && !operation.detached && Date.now() - operation.lastSeen > abandonAfterMs && !operation.cancelRequested) {
      operation.cancelRequested = true; operation.interrupts.trigger();
    }
  }, options.sweepIntervalMs ?? 5000);
  abandon.unref();
  server.once('close', () => clearInterval(abandon));
  return { server, async shutdown(): Promise<void> {
    stopping = true;
    for (const op of operations.values()) if (op.status === 'running') { op.cancelRequested = true; op.interrupts.trigger(); }
    await Promise.allSettled([...pending]);
    await new Promise<void>((done) => server.close(() => done()));
  } };
}

export async function serve(paths: StatePaths): Promise<void> {
  ensurePrivateDir(paths.home);
  if (process.env['THE_FLEET_SERVICE_LOCK'] !== 'held') throw new Error('Start the service through bin/service-lock.py so kernel ownership is held.');
  const socket = serviceSocket(paths);
  if (existsSync(socket)) rmSync(socket);
  const { server, shutdown } = startApi(paths, undefined, { notifyDiskSpace: sendAgentBridgeDiskNotification });
  await new Promise<void>((resolveStarted, reject) => { server.once('error', reject); server.listen(socket, resolveStarted); });
  chmodSync(socket, 0o600);
  const close = () => { void shutdown(); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  await new Promise<void>((resolveClosed) => server.once('close', resolveClosed));
  process.removeListener('SIGTERM', close); process.removeListener('SIGINT', close);
  rmSync(socket, { force: true });
}
