// Upload stream correctness (checked with the system tar) and strict
// extraction of returned artifacts.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { test } from 'node:test';
import { planSnapshot } from '../src/snapshot/select.ts';
import { ArtifactRejectedError, extractTarSafely, SourceChangedError, tarStream, type TarMember } from '../src/snapshot/tar.ts';
import { temporaryDirectory, writeFiles } from './helpers/fixtures.ts';

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

async function writeTar(members: TarMember[], path: string): Promise<void> {
  await pipeline(Readable.from(tarStream(members)), createWriteStream(path));
}

test('the upload stream extracts with the system tar to identical files and links', async () => {
  const directory = temporaryDirectory();
  try {
    const root = join(directory.path, 'source');
    const longName = `${'deep/'.repeat(25)}file with a long name.txt`;
    writeFiles(root, { 'plain.txt': 'plain', 'with space/ünïcødé.txt': 'unicode', [longName]: 'long', 'empty.txt': '' });
    execFileSync('chmod', ['755', join(root, 'plain.txt')]);
    symlinkSync('plain.txt', join(root, 'link'));
    const plan = await planSnapshot(root, { include: ['**'], exclude: [], allowDefaultExcluded: [], maxTotalMiB: 8, maxFileMiB: 8 });
    const archive = join(directory.path, 'upload.tar');
    await writeTar([{ kind: 'data', name: 'meta/note', mode: 0o644, data: Buffer.from('hi') }, ...plan.entries.map((entry) => ({ kind: 'snapshot' as const, name: `src/${entry.relativePath}`, entry }))], archive);
    const out = join(directory.path, 'out');
    mkdirSync(out);
    execFileSync('tar', ['-xpf', archive, '-C', out]);
    assert.equal(readFileSync(join(out, 'meta/note'), 'utf8'), 'hi');
    assert.equal(readFileSync(join(out, 'src/with space/ünïcødé.txt'), 'utf8'), 'unicode');
    assert.equal(readFileSync(join(out, 'src', longName), 'utf8'), 'long');
    assert.equal(readFileSync(join(out, 'src/empty.txt'), 'utf8'), '');
    assert.equal(lstatSync(join(out, 'src/plain.txt')).mode & 0o777, 0o755);
    assert.equal(readlinkSync(join(out, 'src/link')), 'plain.txt');
  } finally {
    directory.cleanup();
  }
});

test('a file edited after planning aborts the upload instead of sending other bytes', async () => {
  const directory = temporaryDirectory();
  try {
    writeFiles(directory.path, { 'a.txt': 'original' });
    const plan = await planSnapshot(directory.path, { include: ['**'], exclude: [], allowDefaultExcluded: [], maxTotalMiB: 8, maxFileMiB: 8 });
    writeFileSync(join(directory.path, 'a.txt'), 'changed!'); // same length, different content
    const entry = plan.entries[0];
    assert.ok(entry);
    await assert.rejects(writeTar([{ kind: 'snapshot', name: 'src/a.txt', entry }], join(directory.path, 'x.tar')), SourceChangedError);
  } finally {
    directory.cleanup();
  }
});

function systemTar(directory: string, cwd: string, paths: string[]): string {
  const archive = join(directory, `artifacts-${Math.random().toString(16).slice(2)}.tar`);
  execFileSync('tar', ['--no-mac-metadata', '-cf', archive, ...paths], { cwd, env: { ...process.env, COPYFILE_DISABLE: '1' } });
  return archive;
}

function paxTar(directory: string, entries: readonly { name: string; mtime: number; pax?: Record<string, string> }[], globalPax: Record<string, string> = {}): string {
  const archive = join(directory, 'pax.tar');
  // Python's independent standard-library writer supplies real PAX records,
  // including per-file overrides and empty values, rather than mirroring our parser.
  execFileSync('python3', ['-c', `import io, json, sys, tarfile
spec = json.loads(sys.argv[2])
with tarfile.open(sys.argv[1], 'w', format=tarfile.PAX_FORMAT, pax_headers=spec['global']) as archive:
    for entry in spec['entries']:
        info = tarfile.TarInfo(entry['name'])
        info.size = 1
        info.mtime = entry['mtime']
        info.pax_headers = entry.get('pax', {})
        # Python 3.9 zeroes the classic mtime whenever a PAX mtime exists;
        # newer writers retain it. Give the empty-override case a known base
        # header so both versions actually test cancellation of global mtime.
        classic = info.tobuf(format=tarfile.USTAR_FORMAT) if info.pax_headers.get('mtime') == '' else None
        archive.addfile(info, io.BytesIO(b'x'))
        if classic is not None:
            end = archive.fileobj.tell()
            archive.fileobj.seek(end - 2 * tarfile.BLOCKSIZE)  # one header and one padded data block
            archive.fileobj.write(classic)
            archive.fileobj.seek(end)
`, archive, JSON.stringify({ entries, global: globalPax })]);
  return archive;
}

test('returned ustar files retain original mtimes and newest-profile ordering', async () => {
  const directory = temporaryDirectory();
  try {
    const src = join(directory.path, 'src');
    writeFiles(src, { 'out/a-newer.json': 'newer', 'out/z-older.json': 'older' });
    utimesSync(join(src, 'out/a-newer.json'), 1700000000, 1700000000);
    utimesSync(join(src, 'out/z-older.json'), 1600000000, 1600000000);
    const archive = systemTar(directory.path, src, ['./out/a-newer.json', './out/z-older.json']);
    const destination = join(directory.path, 'returned');
    await extractTarSafely(archive, destination, { allowedRoots: ['out'], maxBytes: 1024,
      expectedHashes: new Map([['out/a-newer.json', sha256('newer')], ['out/z-older.json', sha256('older')]]) });
    assert.equal(lstatSync(join(destination, 'out/a-newer.json')).mtimeMs, 1700000000000);
    assert.equal(lstatSync(join(destination, 'out/z-older.json')).mtimeMs, 1600000000000);
    const newest = ['a-newer.json', 'z-older.json'].sort((left, right) =>
      lstatSync(join(destination, 'out', right)).mtimeMs - lstatSync(join(destination, 'out', left)).mtimeMs)[0];
    assert.equal(newest, 'a-newer.json');
  } finally {
    directory.cleanup();
  }
});

test('PAX file and global mtimes preserve fractions, overrides and pre-epoch dates', async () => {
  const directory = temporaryDirectory();
  try {
    const entries = [
      { name: 'out/global', mtime: 1600000000 },
      { name: 'out/override', mtime: 1600000000, pax: { mtime: '1700000000.125' } },
      { name: 'out/cancel-global', mtime: 1600000000, pax: { mtime: '' } },
      { name: 'out/before-epoch', mtime: 0, pax: { mtime: '-1.12525' } },
    ];
    const archive = paxTar(directory.path, entries, { mtime: '1650000000.375' });
    const destination = join(directory.path, 'returned');
    await extractTarSafely(archive, destination, { allowedRoots: ['out'], maxBytes: 1024,
      expectedHashes: new Map(entries.map(({ name }) => [name, sha256('x')])) });
    for (const [name, expected] of [['global', 1650000000375], ['override', 1700000000125], ['cancel-global', 1600000000000], ['before-epoch', -1125.25]] as const) {
      const actual = lstatSync(join(destination, 'out', name)).mtimeMs;
      assert.ok(Math.abs(actual - expected) < 0.01, JSON.stringify({ name, actual, expected }));
    }
  } finally {
    directory.cleanup();
  }
});

test('invalid or unrepresentable PAX mtimes reject the artifact', async () => {
  for (const mtime of ['NaN', 'Infinity', '1e3', '1700000000junk', '8640000000001', '-8640000000001']) {
    const directory = temporaryDirectory();
    try {
      const archive = paxTar(directory.path, [{ name: 'out/x', mtime: 0, pax: { mtime } }]);
      await assert.rejects(extractTarSafely(archive, join(directory.path, 'returned'), { allowedRoots: ['out'], maxBytes: 1024,
        expectedHashes: new Map([['out/x', sha256('x')]]) }),
      (error: unknown) => error instanceof ArtifactRejectedError && /invalid mtime/.test(error.message));
    } finally {
      directory.cleanup();
    }
  }
});

test('invalid classic mtime is rejected after the header checksum is validated', async () => {
  const directory = temporaryDirectory();
  try {
    writeFiles(directory.path, { 'out/x': 'x' });
    const archive = join(directory.path, 'classic.tar');
    // Force the entry itself: default BSD tar may emit a preceding PAX header.
    execFileSync('tar', ['--format=ustar', '--no-mac-metadata', '-cf', archive, './out/x'],
      { cwd: directory.path, env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const data = readFileSync(archive);
    assert.equal(String.fromCharCode(data[156] ?? 0), '0');
    data.fill(0, 136, 148);
    data.write('invalid', 136, 'ascii');
    data.write('        ', 148, 8, 'ascii');
    const checksum = data.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
    data.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    writeFileSync(archive, data);
    await assert.rejects(extractTarSafely(archive, join(directory.path, 'returned'), { allowedRoots: ['out'], maxBytes: 1024,
      expectedHashes: new Map([['out/x', sha256('x')]]) }), ArtifactRejectedError);
  } finally {
    directory.cleanup();
  }
});

test('returned artifacts extract with internal app-bundle symlinks and verified hashes', async () => {
  const directory = temporaryDirectory();
  try {
    const src = join(directory.path, 'src');
    writeFiles(src, { 'build.noindex/My App.app/Contents/Frameworks/X.framework/Versions/A/X': 'binary', 'build.noindex/My App.app/Contents/Info.plist': 'plist' });
    symlinkSync('A', join(src, 'build.noindex/My App.app/Contents/Frameworks/X.framework/Versions/Current'));
    const archive = systemTar(directory.path, src, ['./build.noindex/My App.app']);
    const destination = join(directory.path, 'dest');
    const result = await extractTarSafely(archive, destination, {
      allowedRoots: ['build.noindex/My App.app'],
      maxBytes: 1024 * 1024,
      expectedHashes: new Map([
        ['build.noindex/My App.app/Contents/Info.plist', sha256('plist')],
        ['build.noindex/My App.app/Contents/Frameworks/X.framework/Versions/A/X', sha256('binary')],
      ]),
    });
    assert.equal(result.files.length, 2);
    assert.equal(readlinkSync(join(destination, 'build.noindex/My App.app/Contents/Frameworks/X.framework/Versions/Current')), 'A');
  } finally {
    directory.cleanup();
  }
});

async function expectRejected(build: (src: string) => string[], options: { allowedRoots: string[]; expected?: Map<string, string>; maxBytes?: number }, pattern: RegExp): Promise<void> {
  const directory = temporaryDirectory();
  try {
    const src = join(directory.path, 'src');
    mkdirSync(src);
    const archive = systemTar(directory.path, src, build(src));
    const destination = join(directory.path, 'dest');
    await assert.rejects(
      extractTarSafely(archive, destination, { allowedRoots: options.allowedRoots, maxBytes: options.maxBytes ?? 1024 * 1024, expectedHashes: options.expected ?? new Map() }),
      (error: unknown) => error instanceof ArtifactRejectedError && pattern.test(error.message),
    );
    assert.ok(!existsSync(join(directory.path, 'escaped.txt')));
  } finally {
    directory.cleanup();
  }
}

test('artifacts outside the declared paths are rejected', async () => {
  await expectRejected((src) => {
    writeFiles(src, { 'out/a.txt': 'a', 'other/b.txt': 'b' });
    return ['./out', './other'];
  }, { allowedRoots: ['out'], expected: new Map([['out/a.txt', sha256('a')]]) }, /undeclared path/);
});

test('artifact symlinks that escape their artifact are rejected', async () => {
  await expectRejected((src) => {
    mkdirSync(join(src, 'out'));
    symlinkSync('../../escaped.txt', join(src, 'out/link'));
    return ['./out'];
  }, { allowedRoots: ['out'] }, /points outside/);
});

test('writing through an archived symlink is rejected', async () => {
  const directory = temporaryDirectory();
  try {
    // An archive holding the symlink "out/dir -> ." followed by a file "out/dir/x".
    const archive = join(directory.path, 'evil.tar');
    const source = join(directory.path, 's');
    mkdirSync(join(source, 'out'), { recursive: true });
    symlinkSync('.', join(source, 'out/dir'));
    writeFileSync(join(source, 'x'), 'x');
    // Keep this crafted archive focused on the symlink traversal, like systemTar above.
    // Finder metadata can otherwise add a ._dir member and fail the hash check first.
    const tarOptions = { env: { ...process.env, COPYFILE_DISABLE: '1' } };
    execFileSync('tar', ['--no-mac-metadata', '-cf', archive, '-C', source, 'out/dir'], tarOptions);
    execFileSync('tar', ['--no-mac-metadata', '-rf', archive, '-s', ',^x$,out/dir/x,', '-C', source, 'x'], tarOptions);
    await assert.rejects(
      extractTarSafely(archive, join(directory.path, 'dest'), { allowedRoots: ['out'], maxBytes: 1024, expectedHashes: new Map() }),
      (error: unknown) => error instanceof ArtifactRejectedError && /through a symlink/.test(error.message),
    );
  } finally {
    directory.cleanup();
  }
});

test('hash mismatches and size limits are rejected', async () => {
  await expectRejected((src) => {
    writeFiles(src, { 'out/a.txt': 'actual' });
    return ['./out'];
  }, { allowedRoots: ['out'], expected: new Map([['out/a.txt', sha256('different')]]) }, /does not match/);
  await expectRejected((src) => {
    writeFiles(src, { 'out/a.txt': 'x'.repeat(4096) });
    return ['./out'];
  }, { allowedRoots: ['out'], maxBytes: 1024 }, /size limit/);
  await expectRejected((src) => {
    writeFiles(src, { 'out/a.txt': 'a' });
    return ['./out'];
  }, { allowedRoots: ['out'], expected: new Map([['out/a.txt', sha256('a')], ['out/missing.txt', sha256('m')]]) }, /missing/);
});

test('every returned regular file needs a declared remote hash', async () => {
  await expectRejected((src) => {
    writeFiles(src, { 'out/a.txt': 'unlisted' });
    return ['./out'];
  }, { allowedRoots: ['out'] }, /does not match the remote hash/);
});
