// Tar streaming for uploads and strict extraction for returned artifacts.
//
// Upload: Fleet Runner writes its own pax/ustar stream instead of shelling out
// to tar with a file list. That keeps three guarantees in one place: names
// with spaces or unusual characters need no quoting, symlinks are stored as
// links (never followed), and the bytes streamed are exactly the bytes hashed
// into the source digest (each file is re-hashed while it is sent). The stream
// goes straight into ssh, so no snapshot copy is written on this Mac.
//
// Download: the remote side archives declared artifacts with its system tar.
// The archive lands in the private run folder and is extracted here by a
// reader that only accepts regular files, directories and contained relative
// symlinks under the declared artifact paths. Absolute names, "..", hard
// links, devices, writes through a symlink and overwrites are rejected, and
// every file is hashed against the remote manifest. This prevents an artifact
// from escaping into the rest of this Mac.

import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { FleetError } from '../errors.ts';
import { isWithin } from './relativePath.ts';
import type { SnapshotEntry } from './select.ts';
import { openSnapshotFile, snapshotFileChunks, SourceChangedError } from './readFile.ts';
export { SourceChangedError } from './readFile.ts';

const BLOCK = 512;
const READ_CHUNK = 1024 * 1024;

export type TarMember =
  | { readonly kind: 'data'; readonly name: string; readonly mode: number; readonly data: Buffer }
  | { readonly kind: 'snapshot'; readonly name: string; readonly entry: SnapshotEntry };

// ---------------------------------------------------------------- writing

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function needsPax(value: string, limit: number): boolean {
  // eslint-disable-next-line no-control-regex
  return Buffer.byteLength(value) > limit || /[^ -~]/.test(value);
}

function asciiFallback(value: string, limit: number): string {
  return value.replace(/[^ -~]/g, '_').slice(0, limit);
}

function ustarHeader(fields: { name: string; mode: number; size: number; mtime: number; type: '0' | '2' | '5' | 'x'; linkname?: string }): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  header.write(fields.name, 0, 100, 'utf8');
  header.write(octal(fields.mode, 8), 100, 8, 'ascii');
  header.write(octal(0, 8), 108, 8, 'ascii'); // uid
  header.write(octal(0, 8), 116, 8, 'ascii'); // gid
  header.write(octal(fields.size, 12), 124, 12, 'ascii');
  header.write(octal(fields.mtime, 12), 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii'); // checksum placeholder
  header.write(fields.type, 156, 1, 'ascii');
  if (fields.linkname) header.write(fields.linkname, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return `${length}${body}`;
}

function padding(size: number): Buffer {
  const remainder = size % BLOCK;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder, 0);
}

function* entryHeaders(name: string, type: '0' | '2', mode: number, size: number, mtime: number, linkname?: string): Generator<Buffer> {
  const records: string[] = [];
  if (needsPax(name, 100)) records.push(paxRecord('path', name));
  if (linkname !== undefined && needsPax(linkname, 100)) records.push(paxRecord('linkpath', linkname));
  if (records.length > 0) {
    const data = Buffer.from(records.join(''), 'utf8');
    yield ustarHeader({ name: asciiFallback(`PaxHeader/${name}`, 99), mode: 0o644, size: data.length, mtime, type: 'x' });
    yield data;
    yield padding(data.length);
  }
  yield ustarHeader({
    name: needsPax(name, 100) ? asciiFallback(name, 99) : name,
    mode,
    size,
    mtime,
    type,
    ...(linkname === undefined ? {} : { linkname: needsPax(linkname, 100) ? asciiFallback(linkname, 99) : linkname }),
  });
}

/** Streams a tar archive of the given members, verifying snapshot files against their planned hashes. */
export async function* tarStream(members: Iterable<TarMember>): AsyncGenerator<Buffer> {
  const now = Math.floor(Date.now() / 1000);
  for (const member of members) {
    if (member.kind === 'data') {
      yield* entryHeaders(member.name, '0', member.mode, member.data.length, now);
      yield member.data;
      yield padding(member.data.length);
      continue;
    }
    const entry = member.entry;
    if (entry.kind === 'symlink') {
      const current = await fs.readlink(entry.absolutePath).catch(() => undefined);
      if (current !== entry.linkTarget) throw new SourceChangedError(entry.relativePath);
      yield* entryHeaders(member.name, '2', 0o777, 0, entry.mtimeSeconds, entry.linkTarget);
      continue;
    }
    yield* streamSnapshotFile(member.name, entry);
  }
  yield Buffer.alloc(BLOCK * 2, 0);
}

async function* streamSnapshotFile(name: string, entry: Extract<SnapshotEntry, { kind: 'file' }>): AsyncGenerator<Buffer> {
  const handle = await openSnapshotFile(entry);
  try {
    yield* entryHeaders(name, '0', entry.mode, entry.size, entry.mtimeSeconds);
    yield* snapshotFileChunks(handle, entry);
    yield padding(entry.size);
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------- reading

export interface ExtractOptions {
  /** Declared artifact paths (normalized, relative). Every entry must be inside one. */
  readonly allowedRoots: readonly string[];
  readonly maxBytes: number;
  /** Expected SHA-256 per regular file path, from the remote manifest. */
  readonly expectedHashes: ReadonlyMap<string, string>;
}

export interface ExtractedFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface ExtractResult {
  readonly files: readonly ExtractedFile[];
  readonly symlinks: readonly { readonly path: string; readonly target: string }[];
}

export class ArtifactRejectedError extends FleetError {
  constructor(message: string) {
    super('artifactVerification', message);
  }
}

function readString(header: Buffer, offset: number, length: number): string {
  const slice = header.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

function readOctal(header: Buffer, offset: number, length: number): number {
  if ((header[offset] ?? 0) & 0x80) throw new ArtifactRejectedError('Artifact archive uses an unsupported size encoding.');
  const text = readString(header, offset, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new ArtifactRejectedError('Artifact archive has a corrupt header.');
  return Number.parseInt(text, 8);
}

function parsePax(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(offset, space).toString('ascii'), 10);
    if (!Number.isInteger(length) || length <= 0 || offset + length > data.length) throw new ArtifactRejectedError('Artifact archive has a corrupt pax header.');
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return records;
}

function modificationTime(header: Buffer, paxValue: string | undefined): number {
  // An empty per-file PAX value cancels a global value and uses the ustar field.
  const value = paxValue === undefined || paxValue === ''
    ? readOctal(header, 136, 12)
    : /^[+-]?\d+(?:\.\d+)?$/.test(paxValue) ? Number(paxValue) : Number.NaN;
  if (!Number.isFinite(value) || !Number.isFinite(new Date(value * 1000).getTime())) {
    throw new ArtifactRejectedError('Artifact archive has an invalid mtime.');
  }
  return value;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function normalizeEntryPath(raw: string): string {
  let path = raw;
  while (path.startsWith('./')) path = path.slice(2);
  if (path.endsWith('/')) path = path.slice(0, -1);
  if (path === '' || path.startsWith('/') || CONTROL_CHARACTERS.test(path)) throw new ArtifactRejectedError(`Artifact archive has an unsafe path: ${JSON.stringify(raw)}`);
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new ArtifactRejectedError(`Artifact archive has an unsafe path: ${JSON.stringify(raw)}`);
  }
  return path;
}

/** Extracts a tar file into an empty destination directory under the strict rules above. */
export async function extractTarSafely(tarPath: string, destination: string, options: ExtractOptions): Promise<ExtractResult> {
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  const existing = await fs.readdir(destination);
  if (existing.length > 0) throw new ArtifactRejectedError('Artifact destination is not empty.');
  const handle = await fs.open(tarPath, 'r');
  const files: ExtractedFile[] = [];
  const symlinks: { path: string; target: string }[] = [];
  const createdSymlinks = new Set<string>();
  const createdPaths = new Set<string>();
  let totalBytes = 0;
  let offset = 0;
  let pending: Map<string, string> = new Map();
  let globalMtime: string | undefined;
  let zeroBlocks = 0;

  const readExactly = async (length: number, position: number): Promise<Buffer> => {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead !== length) throw new ArtifactRejectedError('Artifact archive is truncated.');
    return buffer;
  };

  const assertNoSymlinkPrefix = (path: string): void => {
    const segments = path.split('/');
    for (let length = 1; length < segments.length; length += 1) {
      if (createdSymlinks.has(segments.slice(0, length).join('/'))) throw new ArtifactRejectedError(`Artifact entry would write through a symlink: ${path}`);
    }
  };

  const rootFor = (path: string): string => {
    const root = options.allowedRoots.find((allowed) => isWithin(path, allowed));
    if (root === undefined) throw new ArtifactRejectedError(`Artifact archive has an undeclared path: ${path}`);
    return root;
  };

  try {
    const stats = await handle.stat();
    while (offset + BLOCK <= stats.size) {
      const header = await readExactly(BLOCK, offset);
      offset += BLOCK;
      if (header.every((byte) => byte === 0)) {
        zeroBlocks += 1;
        if (zeroBlocks === 2) break;
        continue;
      }
      zeroBlocks = 0;
      const storedChecksum = readOctal(header, 148, 8);
      let computed = 0;
      for (let index = 0; index < BLOCK; index += 1) computed += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
      if (computed !== storedChecksum) throw new ArtifactRejectedError('Artifact archive has a corrupt header.');

      const type = String.fromCharCode(header[156] ?? 0);
      let size = readOctal(header, 124, 12);
      const dataOffset = offset;
      if (pending.has('size')) size = Number.parseInt(pending.get('size') ?? '', 10);
      if (!Number.isSafeInteger(size) || size < 0) throw new ArtifactRejectedError('Artifact archive has an invalid size.');
      offset += size + ((BLOCK - (size % BLOCK)) % BLOCK);

      if (type === 'x' || type === 'L' || type === 'K') {
        if (size > 1024 * 1024) throw new ArtifactRejectedError('Artifact archive has an oversized header.');
        const data = await readExactly(size, dataOffset);
        if (type === 'x') {
          for (const [key, value] of parsePax(data)) pending.set(key, value);
        } else {
          pending.set(type === 'L' ? 'path' : 'linkpath', readString(data, 0, data.length));
        }
        continue;
      }
      if (type === 'g') {
        if (size > 1024 * 1024) throw new ArtifactRejectedError('Artifact archive has an oversized header.');
        const records = parsePax(await readExactly(size, dataOffset));
        if (records.has('mtime')) globalMtime = records.get('mtime') || undefined;
        continue;
      }

      const ustarPrefix = readString(header, 257, 6) === 'ustar' ? readString(header, 345, 155) : '';
      const headerName = ustarPrefix ? `${ustarPrefix}/${readString(header, 0, 100)}` : readString(header, 0, 100);
      const rawPath = pending.get('path') ?? headerName;
      const rawLink = pending.get('linkpath') ?? readString(header, 157, 100);
      const paxMtime = pending.has('mtime') ? pending.get('mtime') : globalMtime;
      pending = new Map();
      const path = normalizeEntryPath(rawPath);
      const artifactRoot = rootFor(path);
      assertNoSymlinkPrefix(path);
      if (createdPaths.has(path) && type !== '5') throw new ArtifactRejectedError(`Artifact archive repeats ${path}.`);
      const target = join(destination, ...path.split('/'));

      if (type === '5') {
        await fs.mkdir(target, { recursive: true, mode: 0o755 });
        createdPaths.add(path);
        continue;
      }
      if (type === '2') {
        if (rawLink === '' || rawLink.startsWith('/')) throw new ArtifactRejectedError(`Artifact symlink ${path} is absolute.`);
        const resolved = posix.normalize(posix.join(posix.dirname(path), rawLink));
        if (!isWithin(resolved, artifactRoot) || resolved.startsWith('../')) throw new ArtifactRejectedError(`Artifact symlink ${path} points outside ${artifactRoot}.`);
        await fs.mkdir(dirname(target), { recursive: true, mode: 0o755 });
        await fs.symlink(rawLink, target);
        createdSymlinks.add(path);
        createdPaths.add(path);
        symlinks.push({ path, target: rawLink });
        continue;
      }
      if (type !== '0' && type !== '\0' && type !== '7') {
        throw new ArtifactRejectedError(`Artifact archive has an unsupported entry type for ${path}.`);
      }

      const mtime = modificationTime(header, paxMtime);
      totalBytes += size;
      if (totalBytes > options.maxBytes) throw new ArtifactRejectedError('Artifacts exceed the profile size limit.');
      const mode = readOctal(header, 100, 8) & 0o755;
      await fs.mkdir(dirname(target), { recursive: true, mode: 0o755 });
      const output = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode | 0o600);
      const hash = createHash('sha256');
      let sha256 = '';
      try {
        let remaining = size;
        let position = dataOffset;
        while (remaining > 0) {
          const chunk = await readExactly(Math.min(READ_CHUNK, remaining), position);
          hash.update(chunk);
          await output.write(chunk);
          remaining -= chunk.length;
          position += chunk.length;
        }
        sha256 = hash.digest('hex');
        const expected = options.expectedHashes.get(path);
        if (expected === undefined || expected !== sha256) throw new ArtifactRejectedError(`Artifact ${path} does not match the remote hash.`);
        // Playwright's "last-failed" selection needs original result-file times.
        // Use the already-open safe descriptor, never follow a replacement path.
        // Numeric strings preserve pre-epoch fractions; negative numbers mean "now" in Node.
        const { atimeMs } = await output.stat();
        await output.utimes(atimeMs / 1000, String(mtime));
      } finally {
        await output.close();
      }
      await fs.chmod(target, mode);
      createdPaths.add(path);
      files.push({ path, sha256, bytes: size });
    }
  } finally {
    await handle.close();
  }

  for (const path of options.expectedHashes.keys()) {
    if (!createdPaths.has(path)) throw new ArtifactRejectedError(`Artifact ${path} is missing from the returned archive.`);
  }
  return { files, symlinks };
}
