// Structured worker settings for apps such as the desktop app.
//
// machines.json stays the single source of truth and Agent Bridge keeps owning
// hosts, users and keys. Every write re-validates the whole registry with the
// CLI's own parser. A revision (hash of the saved file) stops an edit made from
// an older view from replacing settings saved somewhere else. Route and remote
// folder changes are refused while the coordinator knows of work on the worker;
// a folder change also needs the old folder's job lock verified free.
// Responses carry environment variable names only, never their values.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_REMOTE_ROOT } from '../cli/machineCommands.ts';
import { usageError } from '../errors.ts';
import { currentRunsDirectory, type StatePaths } from '../paths.ts';
import { listRegistrations, loadMachines, loadProject, saveMachines, serializeMachines } from '../registry.ts';
import { DEFAULT_LIMITS, findMachine, parseLargeScratch, parseMachines, type Machine, type MachineLimits, type MachinesRegistry } from '../schema/machines.ts';
import { ENV_NAME_PATTERN, IDENTIFIER_HINT, IDENTIFIER_PATTERN, Reader } from '../schema/validate.ts';
import { listAgentBridgePairings, type AgentBridgeRoute } from '../transport/agentBridgeConfig.ts';
import { ApiError, notFound } from './apiError.ts';
import type { Coordinator, WorkerObservation } from './coordinator.ts';
import { controllerConfigurationView } from './controllerConfiguration.ts';

export interface ConfigurationDependencies {
  readonly coordinator: Coordinator;
  /** Confirms Agent Bridge has a usable pairing; throws a usage error otherwise. */
  readonly route: (target: string, configPath: string | undefined) => AgentBridgeRoute;
  readonly bridgeConfigPath: () => string;
}

const LIMIT_KEYS = ['maxConcurrentJobs', 'minFreeDiskGiB', 'minAvailableMemoryGiB', 'memoryPressure', 'heavyProcessNames', 'heavyProcessAction', 'keepJobs', 'uploadTimeoutMinutes', 'terminateGraceSeconds'] as const;

/** Changes whenever machines.json changes on disk, including edits made outside this API. */
export function machinesRevision(paths: StatePaths): string {
  if (!existsSync(paths.machinesFile)) return 'none';
  return createHash('sha256').update(readFileSync(paths.machinesFile)).digest('hex').slice(0, 32);
}

function assertRevision(paths: StatePaths, revision: string): void {
  const current = machinesRevision(paths);
  if (revision !== current) {
    throw new ApiError(409, 'revision-conflict', 'These worker settings changed somewhere else while you were editing. Reload them and try again.', { revision: current });
  }
}

function defaultMachineId(registry: MachinesRegistry): string | undefined {
  return registry.defaultMachine === undefined ? undefined : findMachine(registry, registry.defaultMachine)?.id;
}

export function publicMachine(machine: Machine, registry: MachinesRegistry): Record<string, unknown> {
  return {
    id: machine.id,
    description: machine.description ?? null,
    target: machine.transport.target,
    ...(machine.transport.configPath === undefined ? {} : { configPath: machine.transport.configPath }),
    aliases: machine.aliases,
    remoteRoot: machine.remoteRoot,
    pathPrepend: machine.pathPrepend,
    envNames: Object.keys(machine.env).sort(),
    largeScratch: machine.largeScratch ?? null,
    limits: machine.limits,
    isDefault: defaultMachineId(registry) === machine.id,
  };
}

export function configurationView(paths: StatePaths): Record<string, unknown> {
  const revision = machinesRevision(paths);
  const registry = loadMachines(paths);
  return {
    revision,
    defaultMachine: defaultMachineId(registry) ?? null,
    machines: registry.machines.map((machine) => publicMachine(machine, registry)),
    defaults: { remoteRoot: DEFAULT_REMOTE_ROOT, limits: DEFAULT_LIMITS },
    controller: controllerConfigurationView(paths),
    paths: { home: paths.home, machinesFile: paths.machinesFile, runsDirectory: currentRunsDirectory(paths) },
  };
}

/** Agent Bridge pairings with the route The Fleet would use. Key paths are reported as present, never shown. */
export function pairingsView(paths: StatePaths, dependencies: Pick<ConfigurationDependencies, 'bridgeConfigPath'>): Record<string, unknown> {
  const configPath = dependencies.bridgeConfigPath();
  if (!existsSync(configPath)) return { configPath, found: false, targets: [] };
  const registry = loadMachines(paths);
  const owner = (target: string): string | undefined => registry.machines.find((machine) =>
    [machine.transport.target, ...machine.aliases].some((name) => name.toLowerCase() === target.toLowerCase()))?.id;
  return {
    configPath,
    found: true,
    targets: listAgentBridgePairings(readFileSync(configPath, 'utf8')).map((pairing) => {
      const registeredAs = owner(pairing.target);
      return {
        target: pairing.target,
        usable: pairing.route !== undefined,
        ...(pairing.route ? { route: pairing.route.path, host: pairing.route.host, user: pairing.route.user, port: pairing.route.port, keyConfigured: pairing.route.identityFile !== undefined } : {}),
        ...(pairing.problem === undefined ? {} : { problem: pairing.problem }),
        ...(pairing.pairedAt === undefined ? {} : { pairedAt: pairing.pairedAt }),
        ...(registeredAs === undefined ? {} : { registeredAs }),
      };
    }),
  };
}

function strings(reader: Reader, value: unknown): string[] {
  return reader.stringArray(value);
}

function readLimits(reader: Reader, value: unknown): Partial<MachineLimits> {
  // Keys are checked here; values are validated with the whole registry below.
  return reader.object(value, LIMIT_KEYS) as Partial<MachineLimits>;
}

function validated(registry: MachinesRegistry): MachinesRegistry {
  return parseMachines(JSON.parse(JSON.stringify(serializeMachines(registry))), 'worker settings');
}

function withDefault(machines: readonly Machine[], defaultMachine: string | undefined): MachinesRegistry {
  return { schemaVersion: 1, machines, ...(defaultMachine === undefined ? {} : { defaultMachine }) };
}

export function addMachine(paths: StatePaths, dependencies: ConfigurationDependencies, value: unknown): Record<string, unknown> {
  const reader = new Reader('new worker');
  const input = reader.object(value, ['revision', 'id', 'target', 'description', 'aliases', 'remoteRoot', 'pathPrepend', 'env', 'limits', 'makeDefault', 'largeScratch']);
  const revision = reader.child('revision').string(input['revision']);
  const id = reader.child('id').string(input['id'], { pattern: IDENTIFIER_PATTERN, patternHint: IDENTIFIER_HINT });
  const target = reader.child('target').string(input['target']);
  const description = input['description'] === undefined || input['description'] === null ? undefined : reader.child('description').string(input['description']);
  const env = input['env'] === undefined ? {} : reader.child('env').stringRecord(input['env'], ENV_NAME_PATTERN, 'must be a valid environment variable name');
  const makeDefault = reader.child('makeDefault').optionalBoolean(input['makeDefault']) ?? false;
  assertRevision(paths, revision);
  dependencies.route(target, undefined);
  const registry = loadMachines(paths);
  if (registry.machines.some((machine) => machine.id === id)) throw usageError(`A worker named ${id} already exists.`);
  const machine: Machine = {
    id,
    transport: { kind: 'agent-bridge', target },
    aliases: input['aliases'] === undefined ? [] : strings(reader.child('aliases'), input['aliases']),
    remoteRoot: input['remoteRoot'] === undefined ? DEFAULT_REMOTE_ROOT : reader.child('remoteRoot').string(input['remoteRoot']),
    pathPrepend: input['pathPrepend'] === undefined ? [] : strings(reader.child('pathPrepend'), input['pathPrepend']),
    env,
    ...(input['largeScratch'] === undefined || input['largeScratch'] === null ? {} : { largeScratch: parseLargeScratch(reader.child('largeScratch'), input['largeScratch']) }),
    limits: { ...DEFAULT_LIMITS, ...(input['limits'] === undefined ? {} : readLimits(reader.child('limits'), input['limits'])) },
    ...(description === undefined ? {} : { description }),
  };
  const next = validated(withDefault([...registry.machines, machine], makeDefault || registry.machines.length === 0 ? id : defaultMachineId(registry)));
  saveMachines(paths, next);
  dependencies.coordinator.forget(id);
  return { revision: machinesRevision(paths), machine: publicMachine(next.machines.find((candidate) => candidate.id === id) ?? machine, next) };
}

export async function editMachine(paths: StatePaths, dependencies: ConfigurationDependencies, id: string, value: unknown): Promise<Record<string, unknown>> {
  const reader = new Reader(`${id} settings`);
  const input = reader.object(value, ['revision', 'description', 'target', 'aliases', 'remoteRoot', 'pathPrepend', 'env', 'limits', 'isDefault', 'largeScratch']);
  const revision = reader.child('revision').string(input['revision']);
  assertRevision(paths, revision);
  const registry = loadMachines(paths);
  const current = registry.machines.find((machine) => machine.id === id);
  if (!current) throw notFound(`No worker named ${id}.`);

  let env = current.env;
  if (input['env'] !== undefined) {
    // The complete desired set: { keep: true } retains a saved value without
    // the client ever seeing it; { value } replaces it; omitted names are removed.
    const envReader = reader.child('env');
    const raw = input['env'];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) envReader.fail('must be an object');
    const requested = raw as Record<string, unknown>;
    const next: Record<string, string> = {};
    for (const [name, spec] of Object.entries(requested)) {
      const entry = envReader.child(name).object(spec, ['keep', 'value']);
      if (entry['keep'] === true && entry['value'] === undefined) {
        next[name] = current.env[name] ?? envReader.child(name).fail('has no saved value to keep');
      } else if (entry['keep'] === undefined) {
        next[name] = envReader.child(name).child('value').string(entry['value'], { allowEmpty: true });
      } else {
        envReader.child(name).fail('use either {"keep": true} or {"value": "..."}');
      }
    }
    env = next;
  }
  const description = input['description'] === undefined ? current.description : input['description'] === null ? undefined : reader.child('description').string(input['description']);
  const target = input['target'] === undefined ? current.transport.target : reader.child('target').string(input['target']);
  const largeScratch = input['largeScratch'] === undefined ? current.largeScratch : input['largeScratch'] === null ? undefined : parseLargeScratch(reader.child('largeScratch'), input['largeScratch']);
  const next: Machine = {
    id,
    transport: { ...current.transport, target },
    aliases: input['aliases'] === undefined ? current.aliases : strings(reader.child('aliases'), input['aliases']),
    remoteRoot: input['remoteRoot'] === undefined ? current.remoteRoot : reader.child('remoteRoot').string(input['remoteRoot']),
    pathPrepend: input['pathPrepend'] === undefined ? current.pathPrepend : strings(reader.child('pathPrepend'), input['pathPrepend']),
    env,
    ...(largeScratch === undefined ? {} : { largeScratch }),
    limits: input['limits'] === undefined ? current.limits : { ...current.limits, ...readLimits(reader.child('limits'), input['limits']) },
    ...(description === undefined ? {} : { description }),
  };
  const isDefault = reader.child('isDefault').optionalBoolean(input['isDefault']);
  const currentDefault = defaultMachineId(registry);
  const defaultMachine = isDefault === true ? id : isDefault === false && currentDefault === id ? undefined : currentDefault;
  const proposed = validated(withDefault(registry.machines.map((machine) => (machine.id === id ? next : machine)), defaultMachine));

  const routeChanged = target !== current.transport.target;
  const rootChanged = next.remoteRoot !== current.remoteRoot;
  if (JSON.stringify(next.largeScratch) !== JSON.stringify(current.largeScratch)) dependencies.coordinator.assertUnreserved(current, 'Change its large scratch destination');
  if (next.limits.maxConcurrentJobs !== current.limits.maxConcurrentJobs) dependencies.coordinator.assertUnreserved(current, 'Change its job capacity');
  if (routeChanged) dependencies.route(target, current.transport.configPath);
  if (routeChanged || rootChanged) {
    await dependencies.coordinator.assertReconfigurable(current, { root: rootChanged });
    // Work or another edit may have arrived during that check. These final
    // checks and the write are synchronous, so nothing can interleave.
    assertRevision(paths, revision);
    dependencies.coordinator.assertUnreserved(current, 'Change its connection or remote folder');
  }
  saveMachines(paths, proposed);
  dependencies.coordinator.forget(id);
  return { revision: machinesRevision(paths), machine: publicMachine(proposed.machines.find((machine) => machine.id === id) ?? next, proposed) };
}

/** Removes only the registry entry. Pairing, remote folder and local run history are untouched. */
export function removeMachine(paths: StatePaths, dependencies: Pick<ConfigurationDependencies, 'coordinator'>, id: string, revision: string): Record<string, unknown> {
  assertRevision(paths, revision);
  const registry = loadMachines(paths);
  const machine = registry.machines.find((candidate) => candidate.id === id);
  if (!machine) throw notFound(`No worker named ${id}.`);
  dependencies.coordinator.assertUnreserved(machine, 'Remove it');
  const currentDefault = defaultMachineId(registry);
  saveMachines(paths, withDefault(registry.machines.filter((candidate) => candidate.id !== id), currentDefault === id ? undefined : currentDefault));
  dependencies.coordinator.forget(id);
  const warnings: string[] = [];
  for (const entry of safeRegistrations(paths)) {
    try {
      const { manifest } = loadProject(paths, entry.id);
      if (manifest.defaultMachine !== undefined && findMachine(registry, manifest.defaultMachine)?.id === id) {
        warnings.push(`${entry.id} names ${id} as its worker. Its runs refuse until you add a worker with that name or change the project.`);
      }
    } catch { /* A broken manifest is reported by the projects view. */ }
  }
  return { revision: machinesRevision(paths), removed: id, warnings };
}

function safeRegistrations(paths: StatePaths): { id: string }[] {
  try { return listRegistrations(paths); } catch { return []; }
}

function observationView(observation: WorkerObservation): Record<string, unknown> {
  const { report } = observation;
  return {
    observedAt: observation.observedAt,
    reachable: report !== undefined,
    ...(report ? { health: { ...report, tools: Object.fromEntries(report.tools) } } : {}),
    ...(observation.error === undefined ? {} : { error: observation.error }),
  };
}

/** Read-only connection check of a paired computer before it is added or re-pointed. */
export async function checkPairing(paths: StatePaths, dependencies: ConfigurationDependencies, value: unknown): Promise<Record<string, unknown>> {
  const reader = new Reader('worker check');
  const input = reader.object(value, ['target', 'remoteRoot', 'id']);
  const target = reader.child('target').string(input['target']);
  const id = input['id'] === undefined ? 'candidate' : reader.child('id').string(input['id'], { pattern: IDENTIFIER_PATTERN, patternHint: IDENTIFIER_HINT });
  const remoteRoot = input['remoteRoot'] === undefined ? DEFAULT_REMOTE_ROOT : reader.child('remoteRoot').string(input['remoteRoot']);
  const existing = loadMachines(paths).machines.find((machine) => machine.id === id);
  dependencies.route(target, existing?.transport.configPath);
  const [candidate] = parseMachines({ schemaVersion: 1, machines: [{
    id, transport: { kind: 'agent-bridge', target, ...(existing?.transport.configPath === undefined ? {} : { configPath: existing.transport.configPath }) },
    remoteRoot, ...(existing ? { pathPrepend: existing.pathPrepend, limits: existing.limits } : {}),
  }] }, 'worker check').machines;
  if (!candidate) throw usageError('Invalid worker check.');
  const result = await dependencies.coordinator.probe(candidate);
  return {
    target,
    ...observationView(result.observation),
    dispatchingComputer: result.dispatchingComputer,
    ...(result.sameAs === undefined ? {} : { sameAs: result.sameAs }),
  };
}
