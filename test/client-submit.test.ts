// Exercise real submit CLI arguments against a recording Unix-socket API.
// No worker or real coordinator is contacted, including on invalid arguments.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

interface Call { readonly path: string; readonly body: Record<string, unknown> }
const cli = fileURLToPath(new URL('../bin/the-fleet.js', import.meta.url));

async function fixture() {
  const root = mkdtempSync('/tmp/fleet-submit-');
  const calls: Call[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      assert.ok(value && typeof value === 'object' && !Array.isArray(value));
      const path = request.url ?? '';
      calls.push({ path, body: value as Record<string, unknown> });
      const result = path === '/v1/health' ? { application: 'The Fleet', protocolVersion: 1 }
        : path === '/v1/submit' ? { operationId: 'a'.repeat(24) }
        : path === '/v1/submit/plan' ? { planned: true }
        : { status: 'complete', exitCode: 0, output: '', nextOffset: 0 };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result));
    })().catch((error: unknown) => { response.writeHead(500); response.end(String(error)); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(join(root, 'service.sock'), resolve); });
  return {
    calls,
    run: (args: readonly string[]) => new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'submit', '-', ...args], {
        env: { ...process.env, THE_FLEET_HOME: root }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000,
      });
      let stderr = '';
      child.stdout.resume();
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stderr }));
      child.stdin.end(JSON.stringify({ source: '.', files: ['package.json'], command: ['node', '--version'], kind: 'check', timeoutMinutes: 1 }));
    }),
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('normal submit --machine pins the requested worker in the real API payload', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.run(['--machine', 'm1max'])).code, 0);
    assert.deepEqual(f.calls.find((call) => call.path === '/v1/submit')?.body['machines'], ['m1max']);
  } finally { await f.close(); }
});

test('submit accepts equals syntax for the worker and owner', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.run(['--machine=m1max', '--owner=explicit-owner'])).code, 0);
    const body = f.calls.find((call) => call.path === '/v1/submit')?.body;
    assert.deepEqual(body?.['machines'], ['m1max']);
    assert.equal(body?.['owner'], 'explicit-owner');
  } finally { await f.close(); }
});

test('submit keeps ordered --machines candidates and default selection distinct', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.run(['--machines', 'm1max,mini'])).code, 0);
    assert.deepEqual(f.calls.find((call) => call.path === '/v1/submit')?.body['machines'], ['m1max', 'mini']);
    f.calls.length = 0;
    assert.equal((await f.run([])).code, 0);
    const defaultSubmission = f.calls.find((call) => call.path === '/v1/submit');
    assert.ok(defaultSubmission);
    assert.equal(Object.hasOwn(defaultSubmission.body, 'machines'), false);
  } finally { await f.close(); }
});

test('submit dry-run sends its singular worker only to the planning route', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.run(['--dry-run', '--machine', 'm1max'])).code, 0);
    assert.equal(f.calls.find((call) => call.path === '/v1/submit/plan')?.body['machine'], 'm1max');
    assert.equal(f.calls.some((call) => call.path === '/v1/submit'), false);
  } finally { await f.close(); }
});

test('invalid submit worker options fail before any service request', async () => {
  const f = await fixture();
  try {
    for (const args of [
      ['--machine', 'm1max', '--machines', 'mini'], ['--machine', 'm1max', '--machine', 'mini'],
      ['--machines', 'm1max', '--machines', 'mini'], ['--machine'], ['--machines'],
      ['--machine='], ['--machine', 'm1max,mini'], ['--machines='], ['--machines', 'm1max,,mini'],
      ['--machin', 'm1max'], ['--dry-run', '--machines', 'm1max'], ['--dry-run=true'], ['--', '--machine', 'm1max'],
    ]) {
      const result = await f.run(args);
      assert.equal(result.code, 2, `${args.join(' ')}: ${result.stderr}`);
      assert.equal(f.calls.length, 0, args.join(' '));
    }
  } finally { await f.close(); }
});
