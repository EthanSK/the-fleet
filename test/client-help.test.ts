// Verify CLI help never contacts the service or performs a command, while
// preserving literal arguments after -- and ordinary reservation requests.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { main, HELP } from '../src/cli/main.ts';
import { testEnvironment } from './helpers/fixtures.ts';

const cli = fileURLToPath(new URL('../bin/the-fleet.js', import.meta.url));
const legacyCli = fileURLToPath(new URL('../bin/fleet-runner.js', import.meta.url));

async function run(args: readonly string[], home: string, executable = cli, environment: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [executable, ...args], {
      env: { ...process.env, THE_FLEET_HOME: home, ...environment }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function fixture() {
  // macOS Unix sockets need a short path, independent of the worker's TMPDIR.
  const root = mkdtempSync('/tmp/fleet-help-');
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      assert.ok(value && typeof value === 'object' && !Array.isArray(value));
      const path = request.url ?? '';
      calls.push({ path, body: value as Record<string, unknown> });
      const result = path === '/v1/health' ? { application: 'The Fleet', protocolVersion: 1 }
        : path === '/v1/command' ? { operationId: 'a'.repeat(24) }
        : { status: 'complete', exitCode: 0, output: '', nextOffset: 0 };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result));
    })().catch((error: unknown) => { response.writeHead(500); response.end(String(error)); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(join(root, 'service.sock'), resolve); });
  return { root, calls, close: async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  } };
}

test('reserve help prints usage without any service request or reservation', async () => {
  const f = await fixture();
  try {
    for (const flag of ['--help', '-h']) {
      const result = await run(['reserve', flag], f.root);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, HELP);
      assert.deepEqual(f.calls, []);
    }
  } finally { await f.close(); }
});

test('subcommand help bypasses parsing, payload reads and service mutations, including the legacy CLI', async () => {
  const f = await fixture();
  try {
    for (const args of [
      [], ['help'], ['--help'], ['-h'], ['help', 'reserve'], ['submit', '/missing-request.json', '--help'],
      ['maintain', '-h'], ['renew', '--help'], ['release', '-h'], ['activate', '--help'],
      ['recover-reservations', '--help'], ['service', 'stop', '--help'],
      ['rpc', 'POST', '/v1/reservations', '/missing-body.json', '--help'],
      ['machine', 'add', '--help'], ['unregister', '--help'], ['cancel', '-h'], ['lock', 'clear', '--help'],
    ]) {
      const result = await run(args, f.root);
      assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`);
      assert.equal(result.stdout, HELP, args.join(' '));
    }
    assert.equal((await run(['reserve', '--help'], f.root, legacyCli)).stdout, HELP);
    assert.deepEqual(f.calls, []);
  } finally { await f.close(); }
});

test('help succeeds offline without validating external scratch or creating state', async () => {
  const root = mkdtempSync('/tmp/fleet-help-');
  const home = join(root, 'missing-state');
  try {
    for (const args of [['reserve', '--help'], ['service', 'install', '--help'], ['service', 'serve', '-h']]) {
      const result = await run(args, home, cli, { THE_FLEET_RUNS_DIRECTORY: join(root, 'missing.noindex') });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, HELP);
    }
    assert.equal(existsSync(home), false);
    assert.equal(existsSync(join(root, 'missing.noindex')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('literal profile help after -- still reaches the ordinary command route', async () => {
  const f = await fixture();
  const args = ['run', 'example', 'test', '--', '--help', '-h'];
  try {
    const result = await run(args, f.root);
    assert.equal(result.code, 0, result.stderr);
    assert.notEqual(result.stdout, HELP);
    assert.deepEqual(f.calls.find((call) => call.path === '/v1/command')?.body['argv'], args);
  } finally { await f.close(); }
});

test('an ordinary reservation still reaches its API with a plain help label', async () => {
  const f = await fixture();
  try {
    const result = await run(['reserve', '--owner', 'test-owner', '--label', 'help', '--machines', 'worker'], f.root);
    assert.equal(result.code, 0, result.stderr);
    const body = f.calls.find((call) => call.path === '/v1/reservations')?.body;
    assert.ok(body);
    assert.equal(body['owner'], 'test-owner');
    assert.equal(body['label'], 'help');
    assert.deepEqual(body['machines'], ['worker']);
    assert.deepEqual(body['claim'], { mode: 'exclusive', resources: [] });
  } finally { await f.close(); }
});

test('the internal command dispatcher also stops before executing subcommand help', async () => {
  const f = testEnvironment();
  try {
    assert.equal(await main(['unregister', 'missing-project', '--help'], f.context), 0);
    assert.equal(f.stdout.text, HELP);
    assert.equal(f.stderr.text, '');
    assert.equal(existsSync(f.paths.home), false);
  } finally { f.cleanup(); }
});
