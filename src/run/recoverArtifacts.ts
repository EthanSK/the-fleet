// Recovery reuses the same framed stream, archive verification and ACK contract.
import { join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import { FleetError, usageError } from '../errors.ts';
import { ensurePrivateDir, type StatePaths } from '../paths.ts';
import { recoveryCommand } from '../remote/remoteScripts.ts';
import type { Machine } from '../schema/machines.ts';
import { checkRelativePath } from '../snapshot/relativePath.ts';
import { extractTarSafely } from '../snapshot/tar.ts';
import type { Transport } from '../transport/transport.ts';
import { JobSession } from './jobSession.ts';

export async function recoverArtifacts(paths: StatePaths, transport: Transport, machine: Machine, jobId: string): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(jobId)) throw usageError('Invalid job id.');
  const directory = join(paths.runsDir, jobId, `recovered-${Date.now()}.noindex`);
  ensurePrivateDir(directory);
  const archive = join(directory, 'archive.tar.part');
  const session = new JobSession(transport, recoveryCommand(machine, jobId), 'recovery', { onJobStdout: () => {}, onStderr: () => {} });
  session.captureArtifactsTo(archive);
  try {
    const metadata = await session.waitFor(['RECOVERY', 'ERROR'], 45000);
    if (metadata.word === 'ERROR') throw new FleetError('artifactVerification', metadata.rest);
    const value: unknown = JSON.parse(metadata.rest);
    if (typeof value !== 'object' || value === null) throw new Error('Invalid recovery metadata.');
    const { roots, maxBytes } = value as Record<string, unknown>;
    if (!Array.isArray(roots) || roots.length === 0 || roots.some(root => typeof root !== 'string' || !checkRelativePath(root).ok)
        || typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8192 * 1024 * 1024) throw new Error('Invalid recovery bounds.');
    await session.waitFor(['ARTIFACTS'], 45000);
    await session.artifactsWritten();
    const expectedHashes = new Map(session.linesWith('AF').map(line => {
      const space = line.rest.indexOf(' '); return [line.rest.slice(space + 1), line.rest.slice(0, space)] as const;
    }));
    const result = await extractTarSafely(archive, join(directory, 'artifacts'), { allowedRoots: roots as string[], maxBytes, expectedHashes });
    if ((roots as string[]).some(root => !result.files.some(file => file.path === root || file.path.startsWith(`${root}/`)))) throw new Error('Declared output has no verified returned content.');
    // Save the recovery evidence before allowing deletion of the remote copy.
    writeFileSync(join(directory, 'recovery.json'), JSON.stringify({ jobId, machine: machine.id, recoveredAt: new Date().toISOString(), artifacts: result.files }, null, 2));
    session.send('ACK');
    await session.waitFor(['RECOVERED'], 45000);
    await session.waitFor(['BYE'], 45000);
    rmSync(archive);
    return join(directory, 'artifacts');
  } catch (error) {
    session.send('NACK');
    throw error;
  } finally {
    session.closeInput();
    const timer = setTimeout(() => session.kill(), 10000);
    await session.exited;
    clearTimeout(timer);
  }
}
