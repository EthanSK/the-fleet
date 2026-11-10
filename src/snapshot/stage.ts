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
import { openSnapshotFile, snapshotFileChunks, verifySnapshotLink } from './readFile.ts';
import type { SnapshotPlan } from './select.ts';

export async function assertSnapshotUnchanged(plan: SnapshotPlan, cancelled: () => boolean): Promise<void> {
  for (const entry of plan.entries) {
    if (cancelled()) throw new FleetError('transport', 'Source transfer cancelled.');
    if (entry.kind === 'symlink') {
      await verifySnapshotLink(entry);
    } else {
      const handle = await openSnapshotFile(entry);
      try {
        for await (const _chunk of snapshotFileChunks(handle, entry)) { /* verify the live source hash */ }
      } finally {
        await handle.close();
      }
    }
  }
}

export async function stageSnapshot(plan: SnapshotPlan, directory: string, cancelled: () => boolean): Promise<void> {
  await fs.mkdir(directory, { mode: 0o700 });
  try {
    // Validate while copying. The receiver checks the staged bytes against the
    // manifest before it runs anything, so reading them back from scratch
    // here added a full disk pass without adding a job integrity boundary.
    for (const entry of plan.entries) {
      // A cancellation is not a source change. This previously threw
      // SourceChangedError, which could record a cancelled run as a protective
      // source-change stop; reuse syncSource's own cancellation error instead.
      if (cancelled()) throw new FleetError('transport', 'Source transfer cancelled.');
      const destination = join(directory, entry.relativePath);
      await fs.mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      if (entry.kind === 'symlink') {
        await verifySnapshotLink(entry);
        await fs.symlink(entry.linkTarget, destination);
      } else {
        const handle = await openSnapshotFile(entry);
        try {
          await pipeline(Readable.from(snapshotFileChunks(handle, entry)), createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
        } finally {
          await handle.close();
        }
        await fs.chmod(destination, entry.mode);
      }
    }
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
