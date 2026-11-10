// Extraction of existing streamSnapshotFile checks from tar.ts. Tar upload
// and new independent rsync staging share the same bounded, hash-checked file
// reader. Neither path reads beyond the planned size or follows a final link.
import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { FleetError } from '../errors.ts';
import type { SnapshotEntry } from './select.ts';

type FileEntry = Extract<SnapshotEntry, { kind: 'file' }>;

/** Ends the summary of a source-change stop, after the changed path. Receipts
 * written before the typed `abort` field are recognised by this exact text,
 * so keep it stable (see classifyRun in run/receipt.ts). */
export const SOURCE_CHANGED_SUMMARY_SUFFIX = ' changed after planning. Run again once edits settle.';

/** Extraction of the existing tar.ts error; keep its public re-export there.
 * A protective stop, not a Fleet failure: the run aborts before the job starts
 * rather than test a snapshot that no longer matches its plan. */
export class SourceChangedError extends FleetError {
  /** Selected path, relative to the source root, that no longer matches the plan. */
  readonly relativePath: string;

  constructor(relativePath: string) {
    // Exit code 2 (usage) predates the 'aborted' outcome; kept for scripts.
    super('usage', `${relativePath}${SOURCE_CHANGED_SUMMARY_SUFFIX}`);
    this.relativePath = relativePath;
  }
}

/** Refuse a link that no longer points at its planned relative target. */
export async function verifySnapshotLink(entry: Extract<SnapshotEntry, { kind: 'symlink' }>): Promise<void> {
  const current = await fs.readlink(entry.absolutePath).catch(() => undefined);
  if (current !== entry.linkTarget) throw new SourceChangedError(entry.relativePath);
}

/** Extraction of streamSnapshotFile's open/identity checks; caller closes it. */
export async function openSnapshotFile(entry: FileEntry): Promise<FileHandle> {
  let handle: FileHandle;
  try { handle = await fs.open(entry.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new SourceChangedError(entry.relativePath); }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.ino !== entry.inode || stats.dev !== entry.device
      || stats.size !== entry.size || (stats.mode & 0o777) !== entry.mode) throw new SourceChangedError(entry.relativePath);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Extraction of streamSnapshotFile's bounded reader and final-chunk check. */
export async function* snapshotFileChunks(handle: FileHandle, entry: FileEntry): AsyncGenerator<Buffer> {
  const hash = createHash('sha256');
  let remaining = entry.size;
  while (remaining > 0) {
    const buffer = Buffer.alloc(Math.min(1024 * 1024, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) throw new SourceChangedError(entry.relativePath);
    const chunk = buffer.subarray(0, bytesRead);
    hash.update(chunk);
    remaining -= bytesRead;
    if (remaining === 0 && hash.copy().digest('hex') !== entry.sha256) throw new SourceChangedError(entry.relativePath);
    yield chunk;
  }
  if (entry.size === 0 && hash.digest('hex') !== entry.sha256) throw new SourceChangedError(entry.relativePath);
}
