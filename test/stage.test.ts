// A staged rsync input must stay frozen even when an editor rewrites or grows
// the original inode. Otherwise rsync can send bytes beyond the planned limit.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { planSnapshot } from '../src/snapshot/select.ts';
import { stageSnapshot } from '../src/snapshot/stage.ts';
import { temporaryDirectory, writeFiles } from './helpers/fixtures.ts';
import { pruneAbandonedSourceStages, SOURCE_STAGE_OWNER } from '../src/run/receipt.ts';
import { resolveStatePaths } from '../src/paths.ts';
import { createSourceStage, ensureSourceStageRoot, sourceStageRoot } from '../src/run/sourceStage.ts';

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

test('abandoned staging is reclaimed without removing live staging or evidence', async () => {
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
  const starting = setup('starting', [2147483647]);
  writeFileSync(join(starting, SOURCE_STAGE_OWNER), JSON.stringify({ pids: [2147483647], startingRsync: true }));
  try {
    await pruneAbandonedSourceStages(paths);
    assert.equal(existsSync(join(abandoned, 'source.noindex')), false);
    assert.equal(readFileSync(join(abandoned, 'stdout.log'), 'utf8'), 'evidence');
    assert.equal(existsSync(join(live, 'source.noindex')), true);
    assert.equal(existsSync(join(reader, 'source.noindex')), true);
    assert.equal(existsSync(join(starting, 'source.noindex')), true);
  } finally { fixture.cleanup(); }
});

test('new staging cleanup is independent of unavailable results and preserves unknown or live owners', async () => {
  const fixture = temporaryDirectory();
  const paths = { ...resolveStatePaths({ FLEET_RUNNER_HOME: fixture.path }), runsDir: join(fixture.path, 'unmounted.noindex') };
  const setup = async (name: string, owner: unknown): Promise<string> => {
    const directory = await createSourceStage(paths, name);
    writeFiles(directory, { [SOURCE_STAGE_OWNER]: JSON.stringify(owner), 'source.noindex/file': 'copy' });
    return directory;
  };
  try {
    const dead = await setup('dead', { pids: [2147483647], startingRsync: false });
    const live = await setup('live', { pids: [process.pid] });
    const reader = await setup('reader', { pids: [2147483647, process.pid] });
    const uncertain = await setup('uncertain', { pids: [2147483647], startingRsync: true });
    const invalid = await setup('invalid', { pids: ['2147483647'] });
    const unknown = await setup('unknown', { pids: [] });
    const extra = await setup('extra', { pids: [2147483647] });
    writeFiles(extra, { 'keep.txt': 'unrelated' });
    const foreign = join(fixture.path, 'foreign');
    writeFiles(foreign, { 'source.noindex/file': 'foreign' });
    symlinkSync(foreign, join(sourceStageRoot(paths), 'symlink'));
    const linkedOwner = await setup('linked-owner', { pids: [2147483647] });
    const ownerFile = join(linkedOwner, SOURCE_STAGE_OWNER);
    const { unlink } = await import('node:fs/promises');
    await unlink(ownerFile);
    symlinkSync(join(dead, SOURCE_STAGE_OWNER), ownerFile);
    await pruneAbandonedSourceStages(paths);
    assert.equal(existsSync(dead), false);
    for (const directory of [live, reader, uncertain, invalid, unknown, linkedOwner]) assert.equal(existsSync(join(directory, 'source.noindex/file')), true);
    assert.equal(readFileSync(join(foreign, 'source.noindex/file'), 'utf8'), 'foreign');
    assert.equal(readFileSync(join(extra, 'keep.txt'), 'utf8'), 'unrelated');
    assert.equal(existsSync(join(extra, 'source.noindex')), false);
    assert.equal(existsSync(join(extra, SOURCE_STAGE_OWNER)), true);
  } finally { fixture.cleanup(); }
});

test('staging rejects reused ids and a symlinked root without touching its target', async () => {
  const fixture = temporaryDirectory();
  const paths = resolveStatePaths({ FLEET_RUNNER_HOME: fixture.path });
  try {
    await createSourceStage(paths, 'same');
    await assert.rejects(createSourceStage(paths, 'same'), { code: 'EEXIST' });
    await assert.rejects(createSourceStage(paths, '../escape'), /Invalid/);
    const other = { ...paths, home: join(fixture.path, 'other') };
    writeFiles(other.home, { 'target/keep.txt': 'keep' });
    symlinkSync(join(other.home, 'target'), sourceStageRoot(other));
    await assert.rejects(ensureSourceStageRoot(other), /symlink/);
    await pruneAbandonedSourceStages(other);
    assert.deepEqual(readdirSync(join(other.home, 'target')), ['keep.txt']);
  } finally { fixture.cleanup(); }
});
