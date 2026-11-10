// The shared controller preference uses the same revision-checked API as the
// app and other clients. Existing runs retain their admitted destination.
import { resolve } from 'node:path';
import { controllerSettingsRevision, readControllerSettings, saveControllerSettings } from '../controllerSettings.ts';
import { expandHome, validateRunsDirectory, type StatePaths } from '../paths.ts';
import { Reader } from '../schema/validate.ts';
import { ApiError } from './apiError.ts';

export function controllerConfigurationView(paths: StatePaths): Record<string, unknown> {
  return { revision: controllerSettingsRevision(paths.home), runsDirectory: readControllerSettings(paths.home).runsDirectory ?? null };
}

export async function editControllerConfiguration(paths: StatePaths, value: unknown): Promise<void> {
  const reader = new Reader('controller settings');
  const input = reader.object(value, ['revision', 'runsDirectory']);
  const revision = reader.child('revision').string(input['revision']);
  const assertRevision = (): void => {
    const current = controllerSettingsRevision(paths.home);
    if (revision !== current) throw new ApiError(409, 'revision-conflict', 'These settings changed somewhere else. Reload them and try again.', { revision: current });
  };
  assertRevision();
  if (input['runsDirectory'] === null) {
    saveControllerSettings(paths.home, { schemaVersion: 1 });
    return;
  }
  const directory = expandHome(reader.child('runsDirectory').string(input['runsDirectory']));
  await validateRunsDirectory(directory);
  assertRevision();
  saveControllerSettings(paths.home, { schemaVersion: 1, runsDirectory: resolve(directory) });
}
