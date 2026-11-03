// One controller-side notification for a disk problem in an actual operation.
// Agent Bridge supplies the existing native sender; it remains optional so
// missing desktop tools never alter a job's result or the portable runner.
import { execFile } from 'node:child_process';
import type { DiskSpaceProblem, DiskSpaceProblemHandler } from '../run/diskSpace.ts';

export interface DiskSpaceNotification extends DiskSpaceProblem {
  readonly operationId: string;
}
export type DiskSpaceNotificationSender = (notice: DiskSpaceNotification) => void | Promise<void>;
export type NotificationCommand = (file: string, args: readonly string[]) => Promise<void>;

const executeNotification: NotificationCommand = (file, args) => new Promise((resolve, reject) => {
  execFile(file, [...args], { timeout: 10_000, maxBuffer: 16 * 1024, windowsHide: true }, (error) => {
    if (error) reject(error); else resolve();
  });
});

export async function sendAgentBridgeDiskNotification(notice: DiskSpaceNotification, execute: NotificationCommand = executeNotification): Promise<void> {
  // Reuse the existing diagnostic sentence; --local always targets the
  // controller, not the worker. Argument arrays keep labels literal.
  await execute('agent-bridge', ['notify', '--local', '--title', 'The Fleet', '--message', notice.message,
    '--subtitle', notice.machineId, '--group', `the-fleet-disk-${notice.operationId}`]);
}

export function operationDiskNotifier(operationId: string, send?: DiskSpaceNotificationSender,
  warn: (error: unknown) => void = () => {}): DiskSpaceProblemHandler {
  let reported = false;
  const failed = (error: unknown) => { try { warn(error); } catch { /* Diagnostic observers are best effort too. */ } };
  return (problem) => {
    if (reported || !send) return;
    // Claim before dispatch, including a synchronous sender failure: multiple
    // refused workers and a later USB failure still make only one attempt.
    reported = true;
    try { void Promise.resolve(send({ ...problem, operationId })).catch(failed); }
    catch (error) { failed(error); }
  };
}
