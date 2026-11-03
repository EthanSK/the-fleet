// Extraction of the registry's existing atomic private-JSON writer. Callers
// create the owning private directory; settings and registrations share it.
import { renameSync, writeFileSync } from 'node:fs';

export function writeJsonAtomically(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
