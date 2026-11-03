// Read-only Git description of the source tree, for the receipt.
//
// The snapshot is the working tree on disk, so the receipt records which
// commit it started from and how many staged, unstaged and untracked paths
// were present. That makes a dirty run traceable without changing anything:
// --no-optional-locks (and GIT_OPTIONAL_LOCKS=0) stop `git status` refreshing
// the index, and no command here stages, resets, checks out, cleans or
// stashes. A non-Git source simply records null.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitState {
  readonly head: string | null;
  readonly branch: string | null;
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
}

async function git(root: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, '--no-optional-locks', ...args], {
      timeout: 15_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  } catch {
    return undefined;
  }
}

export async function readGitState(root: string): Promise<GitState | null> {
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside?.trim() !== 'true') return null;
  const head = (await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']))?.trim() || null;
  const branchName = (await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']))?.trim() || null;
  // Porcelain v1 with NUL separators: "XY path". Renames carry a second path entry.
  const status = (await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'])) ?? '';
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  const records = status.split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? '';
    if (record.length < 3) continue;
    const indexState = record[0];
    const worktreeState = record[1];
    if (indexState === '?' && worktreeState === '?') {
      untracked += 1;
      continue;
    }
    if (indexState !== ' ' && indexState !== '!') staged += 1;
    if (worktreeState !== ' ' && worktreeState !== '!') unstaged += 1;
    if (indexState === 'R' || indexState === 'C') index += 1; // Skip the rename source path.
  }
  return { head, branch: branchName, staged, unstaged, untracked };
}
