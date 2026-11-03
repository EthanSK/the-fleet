// Local registry of projects and fleet machines.
//
// `fleet-runner register <manifest>` stores a small pointer file in the private
// state directory: the manifest's absolute path and the resolved source root.
// The manifest itself is re-read and re-validated on every command, so editing
// a project's manifest takes effect without re-registering, and the runner
// never holds a stale copy of project commands. A run may point at another
// worktree of the same project with --source; nothing has to be committed or
// stashed first.

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FleetError, usageError } from './errors.ts';
import { ensurePrivateDir, resolveFrom, type StatePaths } from './paths.ts';
import { parseManifest, type ProjectManifest } from './schema/manifest.ts';
import { DEFAULT_LIMITS, findMachine, parseMachines, type Machine, type MachinesRegistry } from './schema/machines.ts';
import { IDENTIFIER_PATTERN, parseJson, Reader } from './schema/validate.ts';
import { writeJsonAtomically } from './fileState.ts';

export interface RegistrationEntry {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly manifestPath: string;
  readonly sourceRoot: string;
  readonly registeredAt: string;
}

export interface LoadedProject {
  readonly entry: RegistrationEntry;
  readonly manifest: ProjectManifest;
}

export function loadManifestFile(manifestPath: string): ProjectManifest {
  if (!existsSync(manifestPath)) throw usageError(`Manifest not found: ${manifestPath}`);
  return parseManifest(parseJson(readFileSync(manifestPath, 'utf8'), manifestPath), manifestPath);
}

/** Resolves the source root for a manifest: explicit --source wins, then the manifest's own sourceRoot. */
export function resolveSourceRoot(manifestPath: string, manifest: ProjectManifest, explicitSource: string | undefined): string {
  if (explicitSource !== undefined) return resolveFrom(process.cwd(), explicitSource);
  if (manifest.sourceRoot !== undefined) return resolveFrom(dirname(manifestPath), manifest.sourceRoot);
  throw usageError(`${manifest.id} has no sourceRoot. Pass --source <dir>.`);
}

export function registerProject(paths: StatePaths, manifestPath: string, explicitSource: string | undefined, replace: boolean): RegistrationEntry {
  const absoluteManifest = resolveFrom(process.cwd(), manifestPath);
  const manifest = loadManifestFile(absoluteManifest);
  const sourceRoot = resolveSourceRoot(absoluteManifest, manifest, explicitSource);
  if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) throw usageError(`Source root is not a directory: ${sourceRoot}`);
  const entryPath = projectEntryPath(paths, manifest.id);
  if (existsSync(entryPath) && !replace) {
    const existing = readEntry(entryPath);
    throw usageError(`${manifest.id} is already registered (manifest ${existing.manifestPath}). Use --replace to update it.`);
  }
  const entry: RegistrationEntry = {
    schemaVersion: 1,
    id: manifest.id,
    manifestPath: absoluteManifest,
    sourceRoot,
    registeredAt: new Date().toISOString(),
  };
  ensurePrivateDir(paths.projectsDir);
  writeJsonAtomically(entryPath, entry);
  return entry;
}

export function unregisterProject(paths: StatePaths, id: string): void {
  const entryPath = projectEntryPath(paths, id);
  if (!existsSync(entryPath)) throw usageError(`${id} is not registered.`);
  rmSync(entryPath);
}

export function listRegistrations(paths: StatePaths): RegistrationEntry[] {
  if (!existsSync(paths.projectsDir)) return [];
  return readdirSync(paths.projectsDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => readEntry(join(paths.projectsDir, name)));
}

export function loadProject(paths: StatePaths, id: string): LoadedProject {
  const entryPath = projectEntryPath(paths, id);
  if (!existsSync(entryPath)) throw usageError(`${id} is not registered. Run: fleet-runner register <manifest.json>`);
  const entry = readEntry(entryPath);
  const manifest = loadManifestFile(entry.manifestPath);
  if (manifest.id !== entry.id) {
    throw usageError(`${entry.manifestPath} now has id "${manifest.id}", registered as "${entry.id}". Re-register it.`);
  }
  return { entry, manifest };
}

export function loadMachines(paths: StatePaths): MachinesRegistry {
  if (!existsSync(paths.machinesFile)) return { schemaVersion: 1, machines: [] };
  return parseMachines(parseJson(readFileSync(paths.machinesFile, 'utf8'), paths.machinesFile), paths.machinesFile);
}

export function saveMachines(paths: StatePaths, registry: MachinesRegistry): void {
  ensurePrivateDir(paths.home);
  const serialized = serializeMachines(registry);
  // Round-trip through the parser so a saved file is always valid.
  parseMachines(JSON.parse(JSON.stringify(serialized)), paths.machinesFile);
  writeJsonAtomically(paths.machinesFile, serialized);
}

/** The stored machines.json shape. Also validates proposed edits before saving. */
export function serializeMachines(registry: MachinesRegistry): Record<string, unknown> {
  // Defaults and empty lists are left out so the file stays short and future
  // default limits apply to machines that never customized them.
  return {
    schemaVersion: registry.schemaVersion,
    ...(registry.defaultMachine === undefined ? {} : { defaultMachine: registry.defaultMachine }),
    machines: registry.machines.map((machine) => ({
      id: machine.id,
      ...(machine.description === undefined ? {} : { description: machine.description }),
      transport: machine.transport,
      ...(machine.aliases.length === 0 ? {} : { aliases: machine.aliases }),
      remoteRoot: machine.remoteRoot,
      ...(machine.pathPrepend.length === 0 ? {} : { pathPrepend: machine.pathPrepend }),
      ...(Object.keys(machine.env).length === 0 ? {} : { env: machine.env }),
      ...(machine.largeScratch === undefined ? {} : { largeScratch: machine.largeScratch }),
      ...(JSON.stringify(machine.limits) === JSON.stringify(DEFAULT_LIMITS) ? {} : { limits: machine.limits }),
    })),
  };
}

/**
 * Chooses the machine for a command: explicit --machine, then the project's
 * defaultMachine, then the registry default, then the only machine.
 * No local fallback exists: a missing machine is an error.
 */
export function selectMachine(registry: MachinesRegistry, explicit: string | undefined, projectDefault: string | undefined): Machine {
  const requested = explicit ?? projectDefault ?? registry.defaultMachine;
  if (requested !== undefined) {
    const machine = findMachine(registry, requested);
    if (!machine) throw usageError(`Unknown machine "${requested}". Run: fleet-runner machines`);
    return machine;
  }
  const only = registry.machines.length === 1 ? registry.machines[0] : undefined;
  if (only) return only;
  if (registry.machines.length === 0) {
    throw usageError('No fleet machines registered. Run: fleet-runner machine add <id> --bridge-target <Agent Bridge target>');
  }
  throw usageError('Several machines are registered. Pass --machine or set defaultMachine.');
}

function projectEntryPath(paths: StatePaths, id: string): string {
  if (!IDENTIFIER_PATTERN.test(id)) throw usageError(`"${id}" is not a valid project id.`);
  return join(paths.projectsDir, `${id}.json`);
}

function readEntry(path: string): RegistrationEntry {
  const reader = new Reader(path);
  const value = reader.object(parseJson(readFileSync(path, 'utf8'), path), ['schemaVersion', 'id', 'manifestPath', 'sourceRoot', 'registeredAt']);
  if (value['schemaVersion'] !== 1) reader.child('schemaVersion').fail('must be 1');
  return {
    schemaVersion: 1,
    id: reader.child('id').string(value['id'], { pattern: IDENTIFIER_PATTERN }),
    manifestPath: reader.child('manifestPath').string(value['manifestPath']),
    sourceRoot: reader.child('sourceRoot').string(value['sourceRoot']),
    registeredAt: reader.child('registeredAt').string(value['registeredAt']),
  };
}

export function assertNever(value: never, context: string): never {
  throw new FleetError('usage', `Unexpected ${context}: ${String(value)}`);
}
