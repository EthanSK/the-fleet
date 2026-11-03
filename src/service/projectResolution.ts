// Match a registered project across Git worktrees while keeping every submitted
// source and recipe in the caller's current checkout. This never runs a job.
import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { usageError } from '../errors.ts';
import { listRegistrations, loadManifestFile, type RegistrationEntry } from '../registry.ts';
import type { StatePaths } from '../paths.ts';
import { Reader } from '../schema/validate.ts';

const execute = promisify(execFile);
interface GitLocation { readonly common: string; readonly subdirectory: string }

async function gitLocation(source: string): Promise<GitLocation | undefined> {
  try {
    // A caller's Git environment must not substitute a different repository.
    const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES']) delete env[key];
    const options = { cwd: source, env, timeout: 5000, maxBuffer: 64 * 1024 };
    const root = (await execute('git', ['rev-parse', '--show-toplevel'], options)).stdout.trim();
    const common = (await execute('git', ['rev-parse', '--git-common-dir'], options)).stdout.trim();
    return { common: realpathSync(resolve(source, common)), subdirectory: relative(realpathSync(root), source) };
  } catch (error) {
    if (error && typeof error === 'object' && 'stderr' in error && String(error.stderr).includes('not a git repository')) return undefined;
    throw usageError(`Cannot read Git worktree: ${source}`);
  }
}

function inside(root: string, file: string): boolean {
  const part = relative(root, file);
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

export interface ResolvedProject {
  readonly id: string;
  readonly sourceRoot: string;
  readonly manifestPath: string;
}

export async function resolveProject(paths: StatePaths, value: unknown): Promise<{ project: ResolvedProject | null }> {
  const reader = new Reader('project resolution');
  const input = reader.object(value, ['source', 'manifestPath']);
  const requested = reader.child('source').string(input['source']);
  const explicit = reader.child('manifestPath').optionalString(input['manifestPath']);
  if (!isAbsolute(requested) || !existsSync(requested) || !statSync(requested).isDirectory()) throw usageError(`Source root is not a directory: ${requested}`);
  const source = realpathSync(requested);
  const registrations = listRegistrations(paths);
  if (!registrations.length) return { project: null };
  const exact = registrations.filter(entry => existsSync(entry.sourceRoot) && realpathSync(entry.sourceRoot) === source);
  const matches: RegistrationEntry[] = [...exact];
  if (!matches.length) {
    const current = await gitLocation(source);
    if (current) for (const entry of registrations) {
      if (!existsSync(entry.sourceRoot)) continue;
      const registered = await gitLocation(realpathSync(entry.sourceRoot));
      if (registered?.common === current.common && registered.subdirectory === current.subdirectory) matches.push(entry);
    }
  }
  if (!matches.length) return { project: null };
  if (matches.length !== 1) throw usageError('More than one project is registered for this source. Remove the duplicate registration.');
  const entry = matches[0];
  if (!entry) throw usageError('Project not found.');
  const registeredRoot = realpathSync(entry.sourceRoot);
  const registeredManifest = existsSync(entry.manifestPath) ? realpathSync(entry.manifestPath) : resolve(entry.manifestPath);
  const registeredRelative = relative(registeredRoot, registeredManifest);
  const currentDefault = join(source, 'the-fleet.json');
  const mapped = inside(registeredRoot, registeredManifest) ? join(source, registeredRelative) : currentDefault;
  // A conventional old recipe may be renamed in the current checkout. Custom
  // registered filenames keep their identity instead of being shadowed.
  const candidate = explicit ?? (registeredRelative === 'fleet.json' && existsSync(currentDefault) ? currentDefault : mapped);
  if (!isAbsolute(candidate) || !existsSync(candidate) || !inside(source, realpathSync(candidate))) throw usageError(`Manifest not found in current source: ${candidate}`);
  const manifestPath = realpathSync(candidate);
  const manifest = loadManifestFile(manifestPath);
  if (manifest.id !== entry.id) throw usageError(`${manifestPath} now has id "${manifest.id}", registered as "${entry.id}". Re-register it.`);
  return { project: { id: entry.id, sourceRoot: source, manifestPath } };
}
