// A staged rsync input must stay frozen even when an editor rewrites or grows
// the original inode. Otherwise rsync can send bytes beyond the planned limit.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { planSnapshot } from '../src/snapshot/select.ts';
import { stageSnapshot } from '../src/snapshot/stage.ts';
import { temporaryDirectory, writeFiles } from './helpers/fixtures.ts';
import { pruneAbandonedSourceStages, SOURCE_STAGE_OWNER } from '../src/run/receipt.ts';
import { resolveStatePaths } from '../src/paths.ts';

test('rsync staging stays frozen when the original inode grows', async () => {
  const fixture = temporaryDirectory();
  const source = join(fixture.path, 'source');
  writeFiles(source, { 'file.txt': 'first' });
  try {
    const plan = await planSnapshot(source, { include: ['**'], exclude: [], allowDefaultExcluded: [], maxTotalMiB: 1, maxFileMiB: 1 });
    const staged = join(fixture.path, 'stage.noindex');
    await stageSnapshot(plan, staged, () => false);
    writeFileSync(join(source, 'file.txt'), 'changed and grown');
    assert.equal(readFileSync(join(staged, 'file.txt'), 'utf8'), 'first');
  } finally { fixture.cleanup(); }
});

test('abandoned staging is reclaimed without removing live staging or evidence', () => {
  const fixture = temporaryDirectory();
  const paths = resolveStatePaths({ FLEET_RUNNER_HOME: fixture.path });
  const setup = (name: string, pids: number[]): string => {
    const directory = join(paths.runsDir, name);
    writeFiles(directory, { '.fleet-run': '', [SOURCE_STAGE_OWNER]: JSON.stringify({ pids }), 'source.noindex/file': 'source', 'stdout.log': 'evidence' });
    return directory;
  };
  const abandoned = setup('abandoned', [2147483647]);
  const live = setup('live', [process.pid]);
  const reader = setup('reader', [2147483647, process.pid]);
  try {
    pruneAbandonedSourceStages(paths);
    assert.equal(existsSync(join(abandoned, 'source.noindex')), false);
    assert.equal(readFileSync(join(abandoned, 'stdout.log'), 'utf8'), 'evidence');
    assert.equal(existsSync(join(live, 'source.noindex')), true);
    assert.equal(existsSync(join(reader, 'source.noindex')), true);
  } finally { fixture.cleanup(); }
});
