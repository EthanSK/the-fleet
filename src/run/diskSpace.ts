// Disk-space signals from an attempted operation, never from status polling.
// Keep the cause typed: generic busy/transport errors must not become alerts.
export interface DiskSpaceProblem {
  readonly machineId: string;
  readonly phase: 'admission' | 'archive';
  readonly message: string;
}

export type DiskSpaceProblemHandler = (problem: DiskSpaceProblem) => void | Promise<void>;

/** Notification observers cannot change admission, cleanup or job outcomes. */
export function reportDiskSpaceProblem(handler: DiskSpaceProblemHandler | undefined, problem: DiskSpaceProblem): void {
  if (!handler) return;
  try { void Promise.resolve(handler(problem)).catch(() => {}); }
  catch { /* The existing operation remains authoritative. */ }
}

/** Only the helper's explicit free-space refusal emits this protocol payload. */
export function parseArchiveDiskSpaceProblem(value: string, machineId: string): DiskSpaceProblem | undefined {
  try {
    const raw: unknown = JSON.parse(value);
    if (!raw || typeof raw !== 'object' || !('phase' in raw) || raw.phase !== 'archive'
      || !('message' in raw) || typeof raw.message !== 'string' || !raw.message.length
      || raw.message.length > 2000 || /[\x00-\x1f]/.test(raw.message)) return undefined;
    return { machineId, phase: 'archive', message: raw.message };
  } catch { return undefined; }
}
