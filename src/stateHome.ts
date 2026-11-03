// The Fleet (formerly Fleet Runner) has one writable state home. The migration
// receipt is the common contract used by the CLI, Python launcher and native app.
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const MIGRATION_RECORD = 'state-migration.json';

export function resolveStateHome(requested: string | undefined, userHome: string): string {
  const selected = requested === undefined ? undefined : resolve(requested);
  if (selected !== undefined && ['.fleet-runner', '.the-fleet'].includes(basename(selected))) userHome = dirname(selected);
  const old = join(userHome, '.fleet-runner'), current = join(userHome, '.the-fleet');
  if (selected !== undefined && selected !== old && selected !== current) return selected;
  const record = join(current, MIGRATION_RECORD);
  if (existsSync(join(old, MIGRATION_RECORD)) && !existsSync(current)) {
    throw new Error('The Fleet state migration is incomplete. Run the-fleet migrate-home again.');
  }
  let migrated = false;
  if (existsSync(record)) {
    const value = JSON.parse(readFileSync(record, 'utf8')) as Record<string, unknown>;
    if (value['schemaVersion'] !== 1 || value['source'] !== old || value['destination'] !== current || value['phase'] !== 'complete') {
      throw new Error('The Fleet state migration is incomplete. Run the-fleet migrate-home again.');
    }
    migrated = true;
  }
  if (existsSync(old) && existsSync(current)) {
    if (!(migrated && lstatSync(old).isSymbolicLink() && realpathSync(old) === realpathSync(current))) {
      throw new Error('Both .fleet-runner and .the-fleet exist. Resolve the conflicting state folders before starting The Fleet.');
    }
  }
  if (selected === current && existsSync(old) && !existsSync(current)) {
    throw new Error('Migrate the existing .fleet-runner folder before selecting .the-fleet.');
  }
  if (selected === old && existsSync(current) && !migrated) {
    throw new Error('The requested legacy folder has no migration record. Use the existing .the-fleet folder.');
  }
  if (migrated || selected === current || existsSync(current)) return current;
  if (existsSync(old)) return old;
  return selected ?? current;
}
