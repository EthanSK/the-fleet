// Private, temporary rsync input containing only the already selected files.
// Independent bounded copies freeze the input; hardlinks would keep changing
// when an editor updates the original and could exceed planned transfer size.
// Recheck the original before and after transfer so editor changes abort the
// run. Rsync never walks the live source tree or sees per-job command/env data.

import { createWriteStream, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FleetError } from '../errors.ts';
import { SourceChangedError, tarStream } from './tar.ts';
import { openSnapshotFile, snapshotFileChunks } from './readFile.ts';
import type { SnapshotEntry, SnapshotPlan } from './select.ts';

async function verifyEntries(entries: readonly SnapshotEntry[]): Promise<void> {
  for (const entry of entries) {
    const stat = await fs.lstat(entry.absolutePath).catch(() => undefined);
    if (!stat || (entry.kind === 'file' && (!stat.isFile() || (stat.mode & 0o777) !== entry.mode)) || (entry.kind === 'symlink' && !stat.isSymbolicLink())) {
      throw new SourceChangedError(entry.relativePath);
    }
  }
  // Reuse the existing streamed inode, size, link-target and SHA-256 checks.
  for await (const _chunk of tarStream(entries.map((entry) => ({ kind: 'snapshot' as const, name: entry.relativePath, entry })))) { /* discard */ }
}

export async function assertSnapshotUnchanged(plan: SnapshotPlan): Promise<void> {
  await verifyEntries(plan.entries);
}

export async function stageSnapshot(plan: SnapshotPlan, directory: string, cancelled: () => boolean): Promise<void> {
  await fs.mkdir(directory, { mode: 0o700 });
  const staged: SnapshotEntry[] = [];
  try {
    await assertSnapshotUnchanged(plan);
    for (const entry of plan.entries) {
      // A cancellation is not a source change. This previously threw
      // SourceChangedError, which could record a cancelled run as a protective
      // source-change stop; reuse syncSource's own cancellation error instead.
      if (cancelled()) throw new FleetError('transport', 'Source transfer cancelled.');
      const destination = join(directory, entry.relativePath);
      await fs.mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      if (entry.kind === 'symlink') {
        await fs.symlink(entry.linkTarget, destination);
        staged.push({ ...entry, absolutePath: destination });
      } else {
        const handle = await openSnapshotFile(entry);
        try {
          await pipeline(Readable.from(snapshotFileChunks(handle, entry)), createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
        } finally {
          await handle.close();
        }
        await fs.chmod(destination, entry.mode);
        const stat = await fs.lstat(destination);
        staged.push({ ...entry, absolutePath: destination, device: stat.dev, inode: stat.ino });
      }
    }
    await verifyEntries(staged);
    await assertSnapshotUnchanged(plan);
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
