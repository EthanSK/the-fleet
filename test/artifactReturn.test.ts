// Real file writers and the exact recovery script: interrupted copies must
// close before cleanup, and uncertain ACKs must preserve verified content.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { test } from 'node:test';
import { JobSession } from '../src/run/jobSession.ts';
import { recoverArtifacts } from '../src/run/recoverArtifacts.ts';
import { tarStream } from '../src/snapshot/tar.ts';
import type { Transport } from '../src/transport/transport.ts';
import { shellQuote } from '../src/transport/shellQuote.ts';
import { testEnvironment, testMachine, writeFiles } from './helpers/fixtures.ts';

function assertClosed(path: string): void {
  if (process.platform !== 'darwin') return;
  const result = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(process.pid), '-F', 'fn', path], { encoding: 'utf8' });
  assert.equal(result.status, 1, `Archive descriptor remains open: ${result.stdout}`);
}

for (const complete of [false, true]) {
  test(`artifact writer closes after ${complete ? 'complete' : 'truncated'} payload and immediate transport exit`, { timeout: 10_000 }, async () => {
    const env = testEnvironment();
    try {
      const archive = join(env.root, 'archive.part');
      const size = 1024 * 1024;
      const command = `python3 -c 'import sys; sys.stdout.buffer.write(b"@@FR ARTIFACTS ${size}\\n" + b"x" * ${complete ? size : 17})'`;
      const session = new JobSession(env.transport, command, 'test', { onJobStdout() {}, onStderr() {} });
      session.captureArtifactsTo(archive);
      await session.waitFor(['ARTIFACTS'], 5000);
      await session.exited;
      if (complete) {
        await session.artifactsWritten();
        assert.deepEqual(readFileSync(archive), Buffer.alloc(size, 'x'));
      } else {
        await assert.rejects(session.artifactsWritten(), /ended early/);
      }
      assertClosed(archive);
    } finally { env.cleanup(); }
  });
}

test('artifact writer open failure rejects without crashing the coordinator', { timeout: 10_000 }, async () => {
  const env = testEnvironment();
  try {
    const archive = join(env.root, 'missing', 'archive.part');
    const session = new JobSession(env.transport, "printf '@@FR ARTIFACTS 1\nx'", 'test', { onJobStdout() {}, onStderr() {} });
    session.captureArtifactsTo(archive);
    await session.waitFor(['ARTIFACTS'], 5000);
    await session.exited;
    await assert.rejects(session.artifactsWritten(), /ENOENT/);
    assertClosed(archive);
  } finally { env.cleanup(); }
});

async function retainedFixture() {
  const env = testEnvironment();
  const job = 'retained-fixture';
  const remote = join(env.remoteRoot, 'jobs', job);
  const content = Buffer.from('verified retained report\n');
  const chunks: Buffer[] = [];
  for await (const chunk of tarStream([{ kind: 'data', name: 'result.txt', mode: 0o600, data: content }])) chunks.push(chunk);
  const archive = Buffer.concat(chunks);
  writeFiles(remote, {
    '.fleet-job': '', 'artifacts.pending': '', 'meta/artifacts': 'result.txt\n',
    'meta/max-artifact-kb': '1024\n',
    'meta/artifact-hashes': `${createHash('sha256').update(content).digest('hex')}  result.txt\n`,
  });
  writeFileSync(join(remote, 'artifacts.tar'), archive);
  return { env, job, remote, content, archive };
}

test('truncated recovery closes and removes only its own partial; remote archive survives EOF', { timeout: 15_000 }, async () => {
  const { env, job, remote, archive } = await retainedFixture();
  const sibling = join(env.paths.runsDir, job, 'recovered-other.noindex', 'keep');
  writeFiles(env.paths.runsDir, { [`${job}/recovered-other.noindex/keep`]: 'other recovery' });
  let partialPath: string | undefined;
  const transport: Transport = { description: env.transport.description, isConnectionFailure: () => false, start(command) {
    const process = env.transport.start(command);
    let header = Buffer.alloc(0);
    let truncated = false;
    const stdout = process.stdout.pipe(new Transform({ transform(chunk: Buffer, _encoding, done) {
      if (!truncated) {
        header = Buffer.concat([header, chunk]);
        const marker = /@@FR ARTIFACTS \d+\n/.exec(header.toString('latin1'));
        if (marker && header.length >= marker.index + marker[0].length + 17) {
          this.push(header.subarray(0, marker.index + marker[0].length + 17));
          truncated = true;
          const own = readdirSync(join(env.paths.runsDir, job)).find(name => name !== 'recovered-other.noindex');
          assert.ok(own);
          partialPath = join(env.paths.runsDir, job, own, 'archive.tar.part');
          process.stdin.end();
        }
      }
      done();
    } }));
    return { ...process, stdout };
  } };
  try {
    await assert.rejects(recoverArtifacts(env.paths, transport, testMachine(), job), /ended early/);
    assert.deepEqual(readdirSync(join(env.paths.runsDir, job)), ['recovered-other.noindex']);
    assert.equal(readFileSync(sibling, 'utf8'), 'other recovery');
    assert.ok(partialPath); assertClosed(partialPath);
    assert.equal(existsSync(join(remote, 'artifacts.pending')), true);
    assert.deepEqual(readFileSync(join(remote, 'artifacts.tar')), archive);
  } finally { env.cleanup(); }
});

test('failed verification removes its local copy and sends NACK to the real recovery script', { timeout: 15_000 }, async () => {
  const { env, job, remote, archive } = await retainedFixture();
  writeFileSync(join(remote, 'meta/artifact-hashes'), `${'0'.repeat(64)}  result.txt\n`);
  try {
    await assert.rejects(recoverArtifacts(env.paths, env.transport, testMachine(), job), /hash/i);
    assert.deepEqual(readdirSync(join(env.paths.runsDir, job)), []);
    assert.equal(existsSync(join(remote, 'artifacts.pending')), true);
    assert.deepEqual(readFileSync(join(remote, 'artifacts.tar')), archive);
  } finally { env.cleanup(); }
});

test('lost confirmation after ACK preserves the verified local recovery and receipt', { timeout: 15_000 }, async () => {
  const { env, job, remote, content } = await retainedFixture();
  const script = readFileSync(new URL('../remote/recover.py', import.meta.url), 'utf8');
  const interrupted = script.replace("print('@@FR RECOVERED', flush=True)", 'sys.exit(0)');
  assert.notEqual(interrupted, script);
  const transport: Transport = { description: env.transport.description, isConnectionFailure: () => false,
    start(command) {
      const modified = command.replace(shellQuote(script), shellQuote(interrupted));
      assert.notEqual(modified, command);
      return env.transport.start(modified);
    } };
  try {
    await assert.rejects(recoverArtifacts(env.paths, transport, testMachine(), job), /ended early/);
    const dirs = readdirSync(join(env.paths.runsDir, job)); assert.equal(dirs.length, 1); assert.ok(dirs[0]);
    const directory = join(env.paths.runsDir, job, dirs[0]);
    assert.deepEqual(readFileSync(join(directory, 'artifacts/result.txt')), content);
    assert.equal(JSON.parse(readFileSync(join(directory, 'recovery.json'), 'utf8')).jobId, job);
    assertClosed(join(directory, 'archive.tar.part'));
    assert.equal(existsSync(join(remote, 'artifacts.pending')), false, 'real script received ACK');
  } finally { env.cleanup(); }
});

test('synchronous transport startup failure removes its exclusively owned recovery directory', async () => {
  const env = testEnvironment();
  const transport: Transport = { description: 'fixture', isConnectionFailure: () => false, start() { throw new Error('startup failed'); } };
  try {
    await assert.rejects(recoverArtifacts(env.paths, transport, testMachine(), 'startup-fixture'), /startup failed/);
    assert.deepEqual(readdirSync(join(env.paths.runsDir, 'startup-fixture')), []);
  } finally { env.cleanup(); }
});
