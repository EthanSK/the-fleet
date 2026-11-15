// Incremental source transfer uses ordinary rsync over the existing transport.
// The remote receiver holds the same upload guard through sync, validation and
// job-source materialization. Its cache contains source only; generated command
// scripts and machine environment stay in disposable job metadata.

import { promises as fs } from 'node:fs';
import { pid as clientPid } from 'node:process';
import { join } from 'node:path';
import { FleetError } from '../errors.ts';
import { rsyncReceiverCommand } from '../remote/remoteScripts.ts';
import { assertSnapshotUnchanged, stageSnapshot } from '../snapshot/stage.ts';
import type { SnapshotPlan } from '../snapshot/select.ts';
import type { Transport } from '../transport/transport.ts';
import type { StatePaths } from '../paths.ts';
import { createSourceStage, removeSourceStage, SOURCE_STAGE_OWNER } from './sourceStage.ts';

export interface RsyncStatistics {
  readonly mode: 'rsync';
  readonly statisticsLog: 'rsync.log';
  readonly sentBytes?: number;
  readonly receivedBytes?: number;
  readonly stageSeconds?: number;
  readonly syncSeconds?: number;
  readonly sourceRecheckSeconds?: number;
}

export function rsyncStatistics(output: string): RsyncStatistics {
  const matchNumber = (pattern: RegExp): number | undefined => {
    const text = pattern.exec(output)?.[1];
    if (text === undefined) return undefined;
    const number = Number(text.replaceAll(',', ''));
    return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
  };
  const sentBytes = matchNumber(/Total bytes sent:\s*([\d,]+)/i) ?? matchNumber(/sent\s+([\d,]+)\s+bytes/i);
  const receivedBytes = matchNumber(/Total bytes received:\s*([\d,]+)/i) ?? matchNumber(/received\s+([\d,]+)\s+bytes/i);
  return { mode: 'rsync', statisticsLog: 'rsync.log', ...(sentBytes === undefined ? {} : { sentBytes }), ...(receivedBytes === undefined ? {} : { receivedBytes }) };
}

export async function syncSource(input: {
  readonly transport: Transport;
  readonly remoteJobDirectory: string;
  readonly runDirectory: string;
  readonly paths: StatePaths;
  readonly jobId: string;
  readonly plan: SnapshotPlan;
  readonly cancelled: () => boolean;
}): Promise<RsyncStatistics> {
  const { transport, plan, runDirectory, cancelled } = input;
  if (!transport.startRsync) throw new FleetError('usage', 'This transport does not support rsync.');
  const stageDirectory = await createSourceStage(input.paths, input.jobId);
  const directory = join(stageDirectory, 'source.noindex');
  let process: ReturnType<NonNullable<Transport['startRsync']>> | undefined;
  let output = '';
  let errors = '';
  const ownerPath = join(stageDirectory, SOURCE_STAGE_OWNER);
  const recordOwner = async (pids: number[]): Promise<void> => {
    await fs.writeFile(`${ownerPath}.tmp`, JSON.stringify({ pids, startingRsync: false }), { mode: 0o600 });
    await fs.rename(`${ownerPath}.tmp`, ownerPath);
  };
  try {
    await recordOwner([clientPid]);
    const stageStarted = performance.now();
    await stageSnapshot(plan, directory, cancelled);
    const stageFinished = performance.now();
    if (cancelled()) throw new FleetError('transport', 'Source transfer cancelled.');
    const syncStarted = performance.now();
    process = transport.startRsync(directory, rsyncReceiverCommand(input.remoteJobDirectory));
    process.stdout.on('data', (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-1024 * 1024); });
    process.stderr.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString('utf8')).slice(-16 * 1024); });
    // The transport waits on stdin before exec'ing rsync with this same PID.
    // Until both owners are recorded, EOF from a killed controller starts no
    // reader. This closes the old permanently-uncertain launch window.
    if (process.pid !== undefined) {
      await recordOwner([clientPid, process.pid]);
      process.stdin.end('go\n');
    } else process.stdin.end();
    const result = await process.exited;
    const recheckStarted = performance.now();
    await fs.writeFile(join(runDirectory, 'rsync.log'), `${output}${errors}`, { mode: 0o600 });
    if (result.code !== 0) throw new FleetError('transport', `Rsync source transfer failed (exit ${result.code ?? result.signal ?? 'unknown'}).`, errors.trim().split('\n').slice(-5));
    await assertSnapshotUnchanged(plan, cancelled);
    if (cancelled()) throw new FleetError('transport', 'Source transfer cancelled.');
    return {
      ...rsyncStatistics(output),
      stageSeconds: (stageFinished - stageStarted) / 1000,
      syncSeconds: (recheckStarted - syncStarted) / 1000,
      sourceRecheckSeconds: (performance.now() - recheckStarted) / 1000,
    };
  } finally {
    // Disconnection/ABORT stops the receiver through its upload guard. This
    // local cleanup never touches the source inode's contents or permissions.
    if (process) {
      process.stdin.end(); // Also releases an uncommitted launch as EOF.
      await process.exited;
    }
    await removeSourceStage(stageDirectory);
  }
}
