// Fleet machine registry (private, in the user-state directory).
//
// One entry per PHYSICAL machine. The heavy-job lock lives on that machine
// under its remoteRoot, so every name that reaches the same host must resolve
// to the same entry: Agent Bridge target "Mac-Mini" and alias "Ethans-Mac-mini"
// are the same Mini and therefore share one lock. Validation refuses a name
// appearing in two entries, and doctor compares a hashed host fingerprint
// across entries and aliases to catch a duplicate registration of one host.
//
// The transport reuses Agent Bridge's existing pairing: only the target name
// is stored here. Host, user, port and key path are read from Agent Bridge's
// own config at connection time and never copied into this file.

import { ENV_NAME_PATTERN, IDENTIFIER_HINT, IDENTIFIER_PATTERN, Reader } from './validate.ts';
import { usageError } from '../errors.ts';

export const MACHINES_SCHEMA_VERSION = 1;

export interface AgentBridgeTransportConfig {
  readonly kind: 'agent-bridge';
  /** Agent Bridge target name, as listed by `agent-bridge list`. */
  readonly target: string;
  /** Optional path to Agent Bridge's config; defaults to Agent Bridge's own resolution. */
  readonly configPath?: string;
}

export type MemoryPressurePolicy = 'refuse-critical' | 'refuse-warn' | 'report-only';
export type HeavyProcessAction = 'refuse' | 'warn';

/** Large temporary files: private sequential output archives, never hot job files. */
export interface LargeScratch {
  readonly mountPoint: string;
  readonly volumeUuid: string;
  readonly directory: string;
  readonly minFileMiB: number;
  readonly minFreeGiB: number;
}

export interface MachineLimits {
  /** Bounded ordinary-job overlap; live memory/disk/pressure checks still apply. */
  readonly maxConcurrentJobs: number;
  /** Separate browser/E2E ceiling; absent means the ordinary limit for older inventories. */
  readonly maxConcurrentE2eJobs?: number;
  readonly minFreeDiskGiB: number;
  readonly minAvailableMemoryGiB: number;
  readonly memoryPressure: MemoryPressurePolicy;
  readonly heavyProcessNames: readonly string[];
  readonly heavyProcessAction: HeavyProcessAction;
  /** Finished remote job folders (logs and results only) kept for inspection. */
  readonly keepJobs: number;
  readonly uploadTimeoutMinutes: number;
  /** Seconds between SIGTERM and SIGKILL when stopping a job's process group. */
  readonly terminateGraceSeconds: number;
}

export interface Machine {
  readonly id: string;
  readonly description?: string;
  readonly transport: AgentBridgeTransportConfig;
  readonly aliases: readonly string[];
  /** Managed root on the machine. Must end in ".noindex"; "~/" is expanded remotely. */
  readonly remoteRoot: string;
  readonly pathPrepend: readonly string[];
  /** Private machine-specific environment, e.g. an installed tool path on that machine. */
  readonly env: Readonly<Record<string, string>>;
  readonly largeScratch?: LargeScratch;
  readonly limits: MachineLimits;
}

export interface MachinesRegistry {
  readonly schemaVersion: typeof MACHINES_SCHEMA_VERSION;
  readonly defaultMachine?: string;
  readonly machines: readonly Machine[];
}

// Process names that indicate another build or test is already using the
// machine. Other chats' jobs don't take this runner's lock, so preflight
// inspects these. Generic runtimes (node, python, java) are left out: they
// also run long-lived light apps and would refuse every job.
export const DEFAULT_HEAVY_PROCESS_NAMES: readonly string[] = [
  'swift-frontend', 'swift-build', 'swift-test', 'swiftc', 'xcodebuild', 'XCBBuildService', 'SWBBuildService',
  'xctest', 'clang', 'clang++', 'ld', 'ld64', 'cc1', 'cc1plus', 'rustc', 'cargo', 'ffmpeg', 'cmake', 'ninja',
  'ibtool', 'actool',
];

export const DEFAULT_LIMITS: MachineLimits = {
  maxConcurrentJobs: 2,
  minFreeDiskGiB: 8,
  minAvailableMemoryGiB: 1,
  memoryPressure: 'refuse-critical',
  heavyProcessNames: DEFAULT_HEAVY_PROCESS_NAMES,
  heavyProcessAction: 'refuse',
  keepJobs: 20,
  uploadTimeoutMinutes: 15,
  terminateGraceSeconds: 20,
};

const TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TARGET_HINT = 'use the Agent Bridge target name (letters, digits, ".", "_" or "-")';

export function parseMachines(value: unknown, source: string): MachinesRegistry {
  const reader = new Reader(source);
  const root = reader.object(value, ['$schema', 'schemaVersion', 'defaultMachine', 'machines']);
  const schemaVersion = reader.child('schemaVersion').number(root['schemaVersion'], { integer: true });
  if (schemaVersion !== MACHINES_SCHEMA_VERSION) reader.child('schemaVersion').fail(`must be ${MACHINES_SCHEMA_VERSION}`);
  const machinesReader = reader.child('machines');
  const machines = machinesReader.array(root['machines']).map((item, index) => parseMachine(machinesReader.child(index), item));

  // Every name must identify one physical machine, so aliases share one lock.
  const owners = new Map<string, string>();
  for (const machine of machines) {
    for (const name of machineNames(machine)) {
      const key = name.toLowerCase();
      const existing = owners.get(key);
      if (existing !== undefined && existing !== machine.id) {
        throw usageError(`${source}: "${name}" is used by machines "${existing}" and "${machine.id}". One physical machine needs one entry so its aliases share one lock.`);
      }
      owners.set(key, machine.id);
    }
  }
  const defaultMachine = reader.child('defaultMachine').optionalString(root['defaultMachine']);
  if (defaultMachine !== undefined && !owners.has(defaultMachine.toLowerCase())) {
    reader.child('defaultMachine').fail(`"${defaultMachine}" is not a registered machine`);
  }
  return { schemaVersion: MACHINES_SCHEMA_VERSION, machines, ...(defaultMachine === undefined ? {} : { defaultMachine }) };
}

/** The machine id, its Agent Bridge target and every alias. */
export function machineNames(machine: Machine): string[] {
  return [machine.id, machine.transport.target, ...machine.aliases];
}

function parseMachine(reader: Reader, value: unknown): Machine {
  const machine = reader.object(value, ['id', 'description', 'transport', 'aliases', 'remoteRoot', 'pathPrepend', 'env', 'limits', 'largeScratch']);
  const id = reader.child('id').string(machine['id'], { pattern: IDENTIFIER_PATTERN, patternHint: IDENTIFIER_HINT });
  const description = reader.child('description').optionalString(machine['description']);

  const transportReader = reader.child('transport');
  const transportValue = transportReader.object(machine['transport'], ['kind', 'target', 'configPath']);
  const kind = transportReader.child('kind').string(transportValue['kind']);
  if (kind !== 'agent-bridge') transportReader.child('kind').fail('must be "agent-bridge" (the existing paired route)');
  const target = transportReader.child('target').string(transportValue['target'], { pattern: TARGET_PATTERN, patternHint: TARGET_HINT });
  const configPath = transportReader.child('configPath').optionalString(transportValue['configPath']);

  const aliases = reader.child('aliases').optionalStringArray(machine['aliases'], { pattern: TARGET_PATTERN, patternHint: TARGET_HINT }) ?? [];
  const remoteRoot = reader.child('remoteRoot').string(machine['remoteRoot'], {
    pattern: /^(~\/|\/)[^\0\n:]*\.noindex$/,
    patternHint: 'must be an absolute or ~/ path ending in ".noindex", such as "~/FleetRunner.noindex"',
  });
  if (remoteRoot.split('/').some((segment) => segment === '..' || segment === '.')) reader.child('remoteRoot').fail('must not contain "." or ".." segments');
  if (remoteRoot === '~/.noindex' || remoteRoot === '/.noindex') reader.child('remoteRoot').fail('needs a dedicated folder name');

  const pathPrepend = reader.child('pathPrepend').optionalStringArray(machine['pathPrepend'], {
    pattern: /^(\/|~\/)[^:\n]*$/,
    patternHint: 'must be an absolute or ~/ path without ":"',
  }) ?? [];
  const env = machine['env'] === undefined ? {} : reader.child('env').stringRecord(machine['env'], ENV_NAME_PATTERN, 'must be a valid environment variable name');
  for (const key of Object.keys(env)) {
    if (key === 'PATH' || key.startsWith('FLEET_RUNNER_')) reader.child('env').child(key).fail('is managed by the runner; use pathPrepend for PATH');
  }

  return {
    id,
    transport: { kind: 'agent-bridge', target, ...(configPath === undefined ? {} : { configPath }) },
    aliases,
    remoteRoot,
    pathPrepend,
    env,
    ...(machine['largeScratch'] === undefined ? {} : { largeScratch: parseLargeScratch(reader.child('largeScratch'), machine['largeScratch']) }),
    limits: parseLimits(reader.child('limits'), machine['limits']),
    ...(description === undefined ? {} : { description }),
  };
}

export function parseLargeScratch(reader: Reader, value: unknown): LargeScratch {
  const input = reader.object(value, ['mountPoint', 'volumeUuid', 'directory', 'minFileMiB', 'minFreeGiB']);
  const mountPoint = reader.child('mountPoint').string(input['mountPoint'], { pattern: /^\/[^\0\n]+$/, patternHint: 'use an absolute mounted-volume path' });
  if (mountPoint.endsWith('/') || mountPoint.split('/').some((part) => part === '.' || part === '..')) reader.child('mountPoint').fail('must name the mount directly, without a trailing slash or dot segments');
  const volumeUuid = reader.child('volumeUuid').string(input['volumeUuid'], { pattern: /^[A-Za-z0-9-]{4,128}$/, patternHint: 'use the volume UUID, not its display name' });
  const directory = reader.child('directory').string(input['directory'], { pattern: /^[^/\0\n][^\0\n]*$/, patternHint: 'use a dedicated relative scratch directory' });
  const parts = directory.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..') || !parts.some((part) => part.endsWith('.noindex'))) reader.child('directory').fail('must stay below the mount and include a .noindex directory');
  return { mountPoint, volumeUuid, directory,
    minFileMiB: reader.child('minFileMiB').optionalNumber(input['minFileMiB'], { min: 1, max: 8192 }) ?? 64,
    minFreeGiB: reader.child('minFreeGiB').optionalNumber(input['minFreeGiB'], { min: 0, max: 1048576 }) ?? 8 };
}

function parseLimits(reader: Reader, value: unknown): MachineLimits {
  if (value === undefined) return DEFAULT_LIMITS;
  const limits = reader.object(value, [
    'minFreeDiskGiB', 'minAvailableMemoryGiB', 'memoryPressure', 'heavyProcessNames', 'heavyProcessAction', 'keepJobs',
    'uploadTimeoutMinutes', 'terminateGraceSeconds', 'maxConcurrentJobs', 'maxConcurrentE2eJobs',
  ]);
  const memoryPressure = reader.child('memoryPressure').optionalString(limits['memoryPressure']) ?? DEFAULT_LIMITS.memoryPressure;
  const pressurePolicies: readonly MemoryPressurePolicy[] = ['refuse-critical', 'refuse-warn', 'report-only'];
  if (!pressurePolicies.includes(memoryPressure as MemoryPressurePolicy)) reader.child('memoryPressure').fail(`must be one of: ${pressurePolicies.join(', ')}`);
  const heavyProcessAction = reader.child('heavyProcessAction').optionalString(limits['heavyProcessAction']) ?? DEFAULT_LIMITS.heavyProcessAction;
  if (heavyProcessAction !== 'refuse' && heavyProcessAction !== 'warn') reader.child('heavyProcessAction').fail('must be "refuse" or "warn"');
  return {
    maxConcurrentJobs: reader.child('maxConcurrentJobs').optionalNumber(limits['maxConcurrentJobs'], { min: 1, max: 16, integer: true }) ?? DEFAULT_LIMITS.maxConcurrentJobs,
    ...(limits['maxConcurrentE2eJobs'] === undefined ? {} : { maxConcurrentE2eJobs: reader.child('maxConcurrentE2eJobs').number(limits['maxConcurrentE2eJobs'], { min: 1, max: 16, integer: true }) }),
    minFreeDiskGiB: reader.child('minFreeDiskGiB').optionalNumber(limits['minFreeDiskGiB'], { min: 0 }) ?? DEFAULT_LIMITS.minFreeDiskGiB,
    minAvailableMemoryGiB: reader.child('minAvailableMemoryGiB').optionalNumber(limits['minAvailableMemoryGiB'], { min: 0 }) ?? DEFAULT_LIMITS.minAvailableMemoryGiB,
    memoryPressure: memoryPressure as MemoryPressurePolicy,
    heavyProcessNames: reader.child('heavyProcessNames').optionalStringArray(limits['heavyProcessNames'], {
      pattern: /^[A-Za-z0-9._+-]+$/,
      patternHint: 'must be a process name (no paths or spaces)',
    }) ?? DEFAULT_LIMITS.heavyProcessNames,
    heavyProcessAction: heavyProcessAction === 'warn' ? 'warn' : 'refuse',
    keepJobs: reader.child('keepJobs').optionalNumber(limits['keepJobs'], { min: 1, max: 500, integer: true }) ?? DEFAULT_LIMITS.keepJobs,
    uploadTimeoutMinutes: reader.child('uploadTimeoutMinutes').optionalNumber(limits['uploadTimeoutMinutes'], { min: 1, max: 240 }) ?? DEFAULT_LIMITS.uploadTimeoutMinutes,
    terminateGraceSeconds: reader.child('terminateGraceSeconds').optionalNumber(limits['terminateGraceSeconds'], { min: 1, max: 600, integer: true }) ?? DEFAULT_LIMITS.terminateGraceSeconds,
  };
}

/** Finds a machine by id, Agent Bridge target or alias (case-insensitive). */
export function findMachine(registry: MachinesRegistry, name: string): Machine | undefined {
  const key = name.toLowerCase();
  return registry.machines.find((machine) => machineNames(machine).some((candidate) => candidate.toLowerCase() === key));
}
