// Ethan's Fleet storage rule: fully ephemeral upload copies can use the
// internal SSD; retained results stay in the configured run store. Keep the
// owner beside the copy so crash cleanup also works without that drive.
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { usageError } from '../errors.ts';
import type { StatePaths } from '../paths.ts';

export const SOURCE_STAGE_OWNER = '.source-stage-owner.json';
const STAGE_MARKER = '.fleet-source-stage';

/** Independent of TMPDIR and the results setting; normally on the boot disk. */
export function sourceStageRoot(paths: StatePaths): string {
  return join(paths.home, 'source-staging.noindex');
}

export async function ensureSourceStageRoot(paths: StatePaths): Promise<string> {
  const root = sourceStageRoot(paths);
  await fs.mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  if (!(await fs.lstat(root)).isDirectory()) throw usageError('Fleet source staging must be a directory, not a symlink.');
  await fs.chmod(root, 0o700);
  return root;
}

export async function createSourceStage(paths: StatePaths, jobId: string): Promise<string> {
  if (!/^[a-z0-9-]+$/.test(jobId)) throw usageError('Invalid source staging job id.');
  const directory = join(await ensureSourceStageRoot(paths), jobId);
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(join(directory, STAGE_MARKER), '', { mode: 0o600, flag: 'wx' });
  return directory;
}

/** Unknown launch states, live/reused PIDs and permission errors are kept. */
export function sourceStageOwnerIsAbandoned(owner: unknown): boolean {
  if (typeof owner !== 'object' || owner === null || !('pids' in owner) || !Array.isArray(owner.pids) || owner.pids.length === 0) return false;
  if ('startingRsync' in owner && owner.startingRsync !== false) return false;
  for (const pid of owner.pids) {
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try { process.kill(pid, 0); return false; }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') return false;
    }
  }
  return true;
}

/** Remove payload first: a crash must never orphan a large unmarked copy. */
export async function removeSourceStage(directory: string): Promise<void> {
  const sourcePath = join(directory, 'source.noindex');
  const source = await fs.lstat(sourcePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (source && !source.isDirectory()) throw usageError('Fleet source staging contains an unexpected file.');
  if (source) await fs.rm(sourcePath, { recursive: true, force: true });
  const owned = new Set([STAGE_MARKER, SOURCE_STAGE_OWNER, `${SOURCE_STAGE_OWNER}.tmp`]);
  if ((await fs.readdir(directory)).some((name) => !owned.has(name))) return;
  await fs.rm(join(directory, `${SOURCE_STAGE_OWNER}.tmp`), { force: true });
  await fs.rm(join(directory, SOURCE_STAGE_OWNER), { force: true });
  await fs.rm(join(directory, STAGE_MARKER), { force: true });
  await fs.rmdir(directory);
}

export async function pruneSourceStages(paths: StatePaths): Promise<void> {
  const root = sourceStageRoot(paths);
  if (!(await fs.lstat(root).catch(() => undefined))?.isDirectory()) return;
  for (const name of await fs.readdir(root)) {
    if (!/^[a-z0-9-]+$/.test(name)) continue;
    const directory = join(root, name);
    try {
      if (!(await fs.lstat(directory)).isDirectory()
        || !(await fs.lstat(join(directory, STAGE_MARKER))).isFile()
        || !(await fs.lstat(join(directory, SOURCE_STAGE_OWNER))).isFile()) continue;
      const owner: unknown = JSON.parse(await fs.readFile(join(directory, SOURCE_STAGE_OWNER), 'utf8'));
      if (sourceStageOwnerIsAbandoned(owner)) await removeSourceStage(directory);
    } catch { /* Unknown or concurrently reclaimed state is kept. */ }
  }
}
