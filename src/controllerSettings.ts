// Controller-wide preferences live beside the inventory, not in a project's
// recipe or a worker's settings. Reads stay possible while a results drive is
// disconnected; each new job must validate its destination before writing.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { writeJsonAtomically } from './fileState.ts';
import { parseJson, Reader } from './schema/validate.ts';

export interface ControllerSettings {
  readonly schemaVersion: 1;
  readonly runsDirectory?: string;
}

export function controllerSettingsFile(home: string): string { return join(home, 'settings.json'); }

export function readControllerSettings(home: string): ControllerSettings {
  const file = controllerSettingsFile(home);
  if (!existsSync(file)) return { schemaVersion: 1 };
  const reader = new Reader(file);
  const value = reader.object(parseJson(readFileSync(file, 'utf8'), file), ['schemaVersion', 'runsDirectory']);
  if (value['schemaVersion'] !== 1) reader.child('schemaVersion').fail('must be 1');
  const runsDirectory = reader.child('runsDirectory').optionalString(value['runsDirectory']);
  if (runsDirectory !== undefined && (!isAbsolute(runsDirectory) || !runsDirectory.endsWith('.noindex'))) {
    reader.child('runsDirectory').fail('must be an absolute .noindex directory');
  }
  return { schemaVersion: 1, ...(runsDirectory === undefined ? {} : { runsDirectory }) };
}

export function controllerSettingsRevision(home: string): string {
  const file = controllerSettingsFile(home);
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 32) : 'none';
}

export function saveControllerSettings(home: string, settings: ControllerSettings): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  writeJsonAtomically(controllerSettingsFile(home), settings);
}
