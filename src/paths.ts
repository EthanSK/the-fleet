// Locates Fleet Runner's private local state.
//
// All registrations, machine definitions, run logs, receipts and returned
// artifacts live in one explicit user-state directory, never in the repository
// or a project checkout. Default: ~/.the-fleet (mode 0700). FLEET_RUNNER_HOME
// overrides it; tests use that to stay isolated.
//
// Generated runtime output goes under runs.noindex so Spotlight does not index
// logs and returned app bundles (excluded from desktop indexing).
// Tar uploads stream directly. Opt-in rsync temporarily stages selected source
// here as independent bounded copies, then removes it. Use the verified
// external runs override below for large staging.

import { mkdirSync, chmodSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { usageError } from './errors.ts';
import { readControllerSettings } from './controllerSettings.ts';
import { resolveStateHome } from './stateHome.ts';

export interface StatePaths {
  readonly home: string;
  readonly machinesFile: string;
  readonly projectsDir: string;
  readonly runsDir: string;
  /** An explicit environment override wins over controller preferences. */
  readonly runsOverride?: string;
}

export function resolveStatePaths(environment: NodeJS.ProcessEnv = process.env): StatePaths {
  const override = environment['THE_FLEET_HOME'] ?? environment['FLEET_RUNNER_HOME'];
  const home = resolveStateHome(override !== undefined && override !== '' ? resolve(expandHome(override)) : undefined, homedir());
  const runsOverride = environment['THE_FLEET_RUNS_DIRECTORY'] ?? environment['FLEET_RUNNER_RUNS_DIRECTORY'];
  let runsDir = readControllerSettings(home).runsDirectory ?? join(home, 'runs.noindex');
  if (runsOverride !== undefined && runsOverride !== '') {
    const expanded = expandHome(runsOverride);
    if (!isAbsolute(expanded) || !expanded.endsWith('.noindex') || !existsSync(expanded) || !statSync(expanded).isDirectory()) {
      throw usageError('FLEET_RUNNER_RUNS_DIRECTORY must name an existing absolute .noindex directory. Verify and create external scratch before using it.');
    }
    runsDir = resolve(expanded);
  }
  return {
    home,
    machinesFile: join(home, 'machines.json'),
    projectsDir: join(home, 'projects'),
    runsDir,
    ...(runsOverride === undefined || runsOverride === '' ? {} : { runsOverride: runsDir }),
  };
}

/** Re-read the shared preference so a new job observes a settings change. */
export function currentRunsDirectory(paths: StatePaths): string {
  return paths.runsOverride ?? readControllerSettings(paths.home).runsDirectory ?? join(paths.home, 'runs.noindex');
}

/** Validate before writes, without making an unavailable drive hide Settings. */
export function resolveRunPaths(paths: StatePaths, explicit?: string): StatePaths {
  const directory = explicit === undefined ? currentRunsDirectory(paths) : expandHome(explicit);
  if (directory !== join(paths.home, 'runs.noindex')) validateRunsDirectory(directory);
  return { ...paths, runsDir: resolve(directory) };
}

export function validateRunsDirectory(directory: string): void {
  if (!isAbsolute(directory) || !directory.endsWith('.noindex') || !existsSync(directory) || !statSync(directory).isDirectory()) {
    throw usageError('Choose an existing absolute .noindex directory for returned files.');
  }
}

/** Creates a private directory (0700) and its parents if needed. */
export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/** Expands a leading "~/" (or a bare "~") using this Mac's home directory. */
export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

/** Resolves a possibly relative path against a base directory, expanding "~". */
export function resolveFrom(baseDir: string, path: string): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}
