// Selects and hashes the exact files a job sends to the fleet machine.
//
// The snapshot is the current working tree as it is on disk, including staged,
// unstaged and untracked edits, so a run never needs a commit or stash. The
// runner only reads files: it never stages, resets, checks out, cleans or
// stashes, and .git is never sent (see rules.ts).
//
// Safety decisions:
// - The walk uses lstat and never descends into symlinked directories, so an
//   external link cannot pull private data from elsewhere on this Mac.
// - A symlink is sent as a link (never dereferenced) and only when its target
//   is relative and stays inside the source root. Absolute or escaping links
//   are skipped and reported.
// - Sockets, FIFOs and devices are skipped.
// - Names with control characters are skipped: they would break line-based
//   logs and protocol output.
// - Each file is hashed here; the upload re-reads it with O_NOFOLLOW, checks
//   the same inode and size, and re-hashes while streaming. A file that
//   changes after planning aborts the upload instead of silently sending bytes
//   that differ from the recorded digest.

import { createHash } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import { join, posix } from 'node:path';
import { usageError } from '../errors.ts';
import type { SyncRules } from '../schema/manifest.ts';
import { compileGlob, couldMatchWithin, coversDirectory, matchesPathOrAncestor, type CompiledGlob } from './glob.ts';
import { matchExclusionRules } from './rules.ts';

export type SnapshotEntry =
  | {
      readonly kind: 'file';
      readonly relativePath: string;
      readonly absolutePath: string;
      readonly size: number;
      /** Permission bits only (no setuid/setgid/sticky). */
      readonly mode: number;
      readonly mtimeSeconds: number;
      readonly sha256: string;
      readonly device: number;
      readonly inode: number;
    }
  | {
      readonly kind: 'symlink';
      readonly relativePath: string;
      readonly absolutePath: string;
      readonly linkTarget: string;
      readonly mtimeSeconds: number;
    };

export type SkipReason =
  | 'safety-rule'
  | 'default-excluded'
  | 'symlink-absolute'
  | 'symlink-outside-root'
  | 'special-file'
  | 'unsafe-name';

export interface SkippedEntry {
  readonly relativePath: string;
  readonly reason: SkipReason;
  readonly detail: string;
}

export interface SnapshotPlan {
  readonly root: string;
  readonly entries: readonly SnapshotEntry[];
  readonly fileCount: number;
  readonly symlinkCount: number;
  readonly totalBytes: number;
  /** Paths that matched an include pattern but were not sent, with the reason. */
  readonly skipped: readonly SkippedEntry[];
  /** Include patterns that matched nothing (usually a typo or a missing generated file). */
  readonly unmatchedIncludes: readonly string[];
  /** Manifest text (one line per entry) whose SHA-256 is the source digest. */
  readonly manifestText: string;
  readonly digest: string;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MIB = 1024 * 1024;

function compileAll(patterns: readonly string[]): CompiledGlob[] {
  return patterns.map((pattern) => {
    const compiled = compileGlob(pattern);
    if (!compiled.ok) throw usageError(`Invalid pattern "${pattern}": ${compiled.reason}`);
    return compiled.glob;
  });
}

export async function planSnapshot(sourceRoot: string, rules: SyncRules): Promise<SnapshotPlan> {
  let root: string;
  try {
    root = await fs.realpath(sourceRoot);
  } catch {
    throw usageError(`Source root not found: ${sourceRoot}`);
  }
  const rootStats = await fs.stat(root);
  if (!rootStats.isDirectory()) throw usageError(`Source root is not a directory: ${root}`);

  const includes = compileAll(rules.include);
  const excludes = compileAll(rules.exclude);
  const allowedDefaults = compileAll(rules.allowDefaultExcluded);
  const matchedIncludes = new Set<string>();
  const entries: SnapshotEntry[] = [];
  const skipped: SkippedEntry[] = [];
  let totalBytes = 0;

  const includeMatch = (relativePath: string): CompiledGlob | undefined => matchesPathOrAncestor(includes, relativePath);

  // Returns true when the walk should not descend/emit this path.
  const isExcluded = (relativePath: string, kind: 'file' | 'directory' | 'symlink'): boolean => {
    if (kind === 'directory') {
      if (excludes.some((glob) => coversDirectory(glob, relativePath))) return true;
      // Skip directories that no include pattern can reach.
      if (!includes.some((glob) => couldMatchWithin(glob, relativePath))) return true;
    } else if (matchesPathOrAncestor(excludes, relativePath)) {
      return true;
    }
    const rule = matchExclusionRules(relativePath, kind);
    if (!rule) return false;
    if (rule.tier === 'safety') {
      // Report only what an include pattern asked for. Directories are pruned
      // here, so a blocked .git folder is listed once, not per object file.
      if (includeMatch(relativePath) || (kind === 'directory' && includes.some((glob) => couldMatchWithin(glob, relativePath)))) {
        skipped.push({ relativePath, reason: 'safety-rule', detail: `never sent (${rule.rule})` });
      }
      return true;
    }
    if (kind === 'directory' ? allowedDefaults.some((glob) => couldMatchWithin(glob, relativePath)) : matchesPathOrAncestor(allowedDefaults, relativePath)) {
      return false;
    }
    if (includeMatch(relativePath) && !isInsideReported(relativePath)) {
      skipped.push({ relativePath, reason: 'default-excluded', detail: `default exclusion (${rule.rule}); allow with sync.allowDefaultExcluded` });
    }
    return true;
  };

  // A skipped directory is reported once, not again for each file inside it.
  const isInsideReported = (relativePath: string): boolean =>
    skipped.some((entry) => relativePath.startsWith(`${entry.relativePath}/`));

  const walk = async (directoryRelative: string): Promise<void> => {
    const directoryAbsolute = directoryRelative === '' ? root : join(root, directoryRelative);
    const names = (await fs.readdir(directoryAbsolute)).sort();
    for (const name of names) {
      const relativePath = directoryRelative === '' ? name : `${directoryRelative}/${name}`;
      const absolutePath = join(directoryAbsolute, name);
      if (CONTROL_CHARACTERS.test(name)) {
        skipped.push({ relativePath: JSON.stringify(relativePath), reason: 'unsafe-name', detail: 'name contains control characters' });
        continue;
      }
      let stats: Stats;
      try {
        stats = await fs.lstat(absolutePath);
      } catch {
        continue; // Removed during the walk.
      }
      if (stats.isDirectory()) {
        if (isExcluded(relativePath, 'directory')) continue;
        await walk(relativePath);
        continue;
      }
      const included = includeMatch(relativePath);
      if (!included) continue;
      if (stats.isSymbolicLink()) {
        if (isExcluded(relativePath, 'symlink')) continue;
        matchedIncludes.add(included.pattern);
        const linkTarget = await fs.readlink(absolutePath);
        const symlinkCheck = checkSymlinkTarget(relativePath, linkTarget);
        if (symlinkCheck) {
          skipped.push({ relativePath, reason: symlinkCheck, detail: `points to ${linkTarget}` });
          continue;
        }
        entries.push({ kind: 'symlink', relativePath, absolutePath, linkTarget, mtimeSeconds: Math.floor(stats.mtimeMs / 1000) });
        continue;
      }
      if (!stats.isFile()) {
        matchedIncludes.add(included.pattern);
        skipped.push({ relativePath, reason: 'special-file', detail: 'not a regular file, directory or symlink' });
        continue;
      }
      if (isExcluded(relativePath, 'file')) continue;
      matchedIncludes.add(included.pattern);
      if (stats.size > rules.maxFileMiB * MIB) {
        throw usageError(`${relativePath} is ${formatMiB(stats.size)} (limit ${rules.maxFileMiB} MiB). Exclude it or raise sync.maxFileMiB.`);
      }
      totalBytes += stats.size;
      if (totalBytes > rules.maxTotalMiB * MIB) {
        throw usageError(`Selected source exceeds ${rules.maxTotalMiB} MiB. Narrow sync.include or raise sync.maxTotalMiB.`);
      }
      entries.push({
        kind: 'file',
        relativePath,
        absolutePath,
        size: stats.size,
        mode: stats.mode & 0o777,
        mtimeSeconds: Math.floor(stats.mtimeMs / 1000),
        sha256: await hashFile(absolutePath, stats),
        device: stats.dev,
        inode: stats.ino,
      });
    }
  };

  await walk('');
  const manifestText = renderSourceManifest(entries);
  return {
    root,
    entries,
    fileCount: entries.filter((entry) => entry.kind === 'file').length,
    symlinkCount: entries.filter((entry) => entry.kind === 'symlink').length,
    totalBytes,
    skipped,
    unmatchedIncludes: rules.include.filter((pattern) => !matchedIncludes.has(pattern)),
    manifestText,
    digest: createHash('sha256').update(manifestText).digest('hex'),
  };
}

/** Returns a skip reason when a symlink must not be sent, or undefined when it is safe. */
export function checkSymlinkTarget(relativePath: string, linkTarget: string): SkipReason | undefined {
  if (linkTarget.startsWith('/') || linkTarget.startsWith('~')) return 'symlink-absolute';
  const resolved = posix.normalize(posix.join(posix.dirname(relativePath), linkTarget));
  if (resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')) return 'symlink-outside-root';
  return undefined;
}

/**
 * One line per entry. Paths are JSON-encoded so tabs or unusual characters
 * cannot make two different trees produce the same text. The digest covers
 * content, permission bits and link targets, not timestamps.
 */
export function renderSourceManifest(entries: readonly SnapshotEntry[]): string {
  return entries
    .map((entry) =>
      entry.kind === 'file'
        ? `file\t${entry.mode.toString(8).padStart(4, '0')}\t${entry.size}\t${entry.sha256}\t${JSON.stringify(entry.relativePath)}`
        : `link\t-\t-\t${JSON.stringify(entry.linkTarget)}\t${JSON.stringify(entry.relativePath)}`,
    )
    .join('\n')
    .concat(entries.length > 0 ? '\n' : '');
}

async function hashFile(absolutePath: string, stats: Stats): Promise<string> {
  const handle = await fs.open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.ino !== stats.ino || opened.dev !== stats.dev) throw usageError(`${absolutePath} changed while it was being read.`);
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

export function formatMiB(bytes: number): string {
  return `${(bytes / MIB).toFixed(bytes < 10 * MIB ? 1 : 0)} MiB`;
}
