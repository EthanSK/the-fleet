// Exercise the actual controller crash windows with native rsync, rather
// than guessing a dead PID means no reader was launched.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveStatePaths } from '../src/paths.ts';
import { pruneAbandonedSourceStages } from '../src/run/receipt.ts';
import { SOURCE_STAGE_OWNER, sourceStageRoot } from '../src/run/sourceStage.ts';
import { temporaryDirectory, waitUntil } from './helpers/fixtures.ts';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

for (const beforeOwnerWrite of [true, false]) test(`controller SIGKILL ${beforeOwnerWrite ? 'before' : 'after'} recording rsync ownership`, { timeout: 20000 }, async () => {
  const fixture = temporaryDirectory();
  const paths = resolveStatePaths({ FLEET_RUNNER_HOME: fixture.path });
  const source = join(fixture.path, 'source');
  const destination = join(fixture.path, 'destination');
  const run = join(fixture.path, 'run');
  for (const path of [source, destination, run]) mkdirSync(path);
  writeFileSync(join(source, 'data'), randomBytes(512 * 1024));
  writeFileSync(join(run, 'stdout.log'), 'evidence');
  const script = join(fixture.path, 'crash.mjs');
  writeFileSync(script, `
import { planSnapshot } from ${JSON.stringify(new URL('../src/snapshot/select.ts', import.meta.url).href)};
import { syncSource } from ${JSON.stringify(new URL('../src/run/rsyncTransfer.ts', import.meta.url).href)};
import { startGatedRsync } from ${JSON.stringify(new URL('../src/transport/transport.ts', import.meta.url).href)};
const plan = await planSnapshot(${JSON.stringify(source)}, { include: ['**'], exclude: [], allowDefaultExcluded: [], maxTotalMiB: 1, maxFileMiB: 1 });
await syncSource({ paths: ${JSON.stringify(paths)}, jobId: 'crash', runDirectory: ${JSON.stringify(run)}, remoteJobDirectory: 'unused', plan, cancelled: () => false,
 transport: { description: 'native local rsync crash fixture', start() { throw Error('unused'); }, isConnectionFailure() { return false; },
 startRsync(directory) {
  const child = startGatedRsync(['-rc', '--inplace', '--bwlimit=32', directory + '/', ${JSON.stringify(destination + '/')}], process.env);
  process.send({ pid: child.pid });
  ${beforeOwnerWrite ? 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);' : ''}
  return child;
 } } });
`);
  const controller = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const exited = once(controller, 'exit');
  assert.ok(controller.stdout && controller.stderr);
  controller.stdout.resume();
  let errors = '';
  controller.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
  let reader: number | undefined;
  try {
    const message = await Promise.race([
      once(controller, 'message'), exited.then(() => { throw new Error(`controller exited early: ${errors}`); }),
    ]);
    reader = (message[0] as { pid: number }).pid;
    assert.ok(Number.isSafeInteger(reader) && reader > 0);
    const stage = join(sourceStageRoot(paths), 'crash');
    if (!beforeOwnerWrite) {
      assert.equal(await waitUntil(() => spawnSync('/bin/ps', ['-p', String(reader), '-o', 'comm='], { encoding: 'utf8' }).stdout.trim().endsWith('/rsync'), 3000), true);
      assert.ok(JSON.parse(readFileSync(join(stage, SOURCE_STAGE_OWNER), 'utf8')).pids.includes(reader));
    }
    controller.kill('SIGKILL');
    await exited;
    if (beforeOwnerWrite) {
      assert.equal(await waitUntil(() => !alive(reader!), 3000), true);
      assert.equal(existsSync(join(destination, 'data')), false, 'EOF must not launch an unrecorded reader');
    } else {
      assert.equal(alive(reader), true);
      await pruneAbandonedSourceStages(paths);
      assert.equal(existsSync(join(stage, 'source.noindex/data')), true, 'a surviving reader owns its copy');
      process.kill(reader, 'SIGTERM');
      assert.equal(await waitUntil(() => !alive(reader!), 5000), true);
    }
    await pruneAbandonedSourceStages(paths);
    assert.deepEqual(readdirSync(sourceStageRoot(paths)), []);
    assert.equal(readFileSync(join(run, 'stdout.log'), 'utf8'), 'evidence');
  } finally {
    if (controller.exitCode === null && controller.signalCode === null) controller.kill('SIGKILL');
    await exited;
    if (reader !== undefined && alive(reader)) { process.kill(reader, 'SIGTERM'); await waitUntil(() => !alive(reader!), 5000); }
    fixture.cleanup();
  }
});
