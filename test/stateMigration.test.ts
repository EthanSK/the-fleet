// Exercise real filesystem renames and kernel locks in private fixture homes.
// Worker traffic, user configuration and native notifications are never used.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { resolveStateHome } from '../src/stateHome.ts';
import { callApi, ensureService } from '../src/service/client.ts';
import { resolveStatePaths } from '../src/paths.ts';

const script = fileURLToPath(new URL('../bin/migrate-state.py', import.meta.url));
const lock = fileURLToPath(new URL('../bin/service-lock.py', import.meta.url));
const cli = fileURLToPath(new URL('../bin/the-fleet.js', import.meta.url));
function fixture() {
  // macOS Unix sockets need a short path; the per-user TMPDIR is too long.
  const parent = realpathSync(mkdtempSync('/tmp/fleet-migration-'));
  const old = join(parent, '.fleet-runner'), current = join(parent, '.the-fleet');
  mkdirSync(old, { mode: 0o700 });
  return { parent, old, current, close: () => rmSync(parent, { recursive: true, force: true }) };
}
function migrate(parent: string, dry = false) {
  return spawnSync('python3', ['-B', script, '--user-home', parent, ...(dry ? ['--dry-run'] : [])], { encoding: 'utf8' });
}

test('the migration CLI refuses to act on another installation under a custom home override', () => {
  const f = fixture();
  try {
    const result = spawnSync(process.execPath, [cli, 'migrate-home', '--dry-run'], {
      env: { ...process.env, THE_FLEET_HOME: join(f.parent, 'custom') }, encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /default state folder/);
    assert.ok(existsSync(f.old));
    assert.equal(existsSync(f.current), false);
  } finally { f.close(); }
});

test('default discovery keeps legacy state until explicit migration and refuses split state', () => {
  const f = fixture();
  try {
    assert.equal(resolveStateHome(undefined, f.parent), f.old);
    assert.throws(() => resolveStateHome(f.current, f.parent), /Migrate/);
    assert.equal(resolveStateHome('/custom/fleet', f.parent), '/custom/fleet');
    mkdirSync(f.current);
    assert.throws(() => resolveStateHome(undefined, f.parent), /Both/);
    assert.equal(migrate(f.parent).status, 2);
    assert.ok(existsSync(f.old));
  } finally { f.close(); }
});

test('rename preserves state inodes, modes, ownership bytes and immutable receipts', () => {
  const f = fixture();
  try {
    const state = '{"schemaVersion":1,"secretFixture":"unchanged"}\n';
    for (const name of ['machines.json', 'reservations.json']) writeFileSync(join(f.old, name), state, { mode: 0o600 });
    const receipts = join(f.old, 'runs.noindex', 'fixture'); mkdirSync(receipts, { recursive: true });
    writeFileSync(join(receipts, 'receipt.json'), JSON.stringify({ source: f.old }));
    writeFileSync(join(f.old, 'run-index.json'), JSON.stringify({ schemaVersion: 1, runs: [{ receiptPath: join(receipts, 'receipt.json') }] }));
    mkdirSync(join(f.old, 'projects'));
    writeFileSync(join(f.old, 'projects', 'example.json'), JSON.stringify({ sourceRoot: f.old, manifestPath: join(f.old, 'recipe.json') }));
    writeFileSync(join(f.old, 'settings.json'), JSON.stringify({ schemaVersion: 1, runsDirectory: '/external/results.noindex' }));
    const inode = statSync(f.old).ino, receipt = readFileSync(join(receipts, 'receipt.json'));
    const before = readFileSync(join(f.old, 'machines.json'));
    assert.equal(migrate(f.parent, true).status, 0);
    assert.equal(existsSync(join(f.parent, '.the-fleet-migration.lock')), false, 'dry run writes nothing');
    const result = migrate(f.parent); assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(f.old), false);
    assert.equal(statSync(f.current).ino, inode);
    assert.equal(statSync(join(f.current, 'machines.json')).mode & 0o777, 0o600);
    assert.deepEqual(readFileSync(join(f.current, 'machines.json')), before);
    assert.equal(readFileSync(join(f.current, 'reservations.json'), 'utf8'), state);
    assert.deepEqual(readFileSync(join(f.current, 'runs.noindex/fixture/receipt.json')), receipt);
    assert.equal(JSON.parse(readFileSync(join(f.current, 'run-index.json'), 'utf8')).runs[0].receiptPath, join(f.current, 'runs.noindex/fixture/receipt.json'));
    assert.equal(JSON.parse(readFileSync(join(f.current, 'projects/example.json'), 'utf8')).sourceRoot, f.current);
    assert.equal(JSON.parse(readFileSync(join(f.current, 'settings.json'), 'utf8')).runsDirectory, '/external/results.noindex');
    assert.equal(resolveStateHome(f.old, f.parent), f.current);
    assert.equal(JSON.parse(migrate(f.parent).stdout).state, 'already-complete');
  } finally { f.close(); }
});

test('interrupted migration blocks startup and resumes its pointer rewrites', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.old, 'state-migration.json'), JSON.stringify({ schemaVersion: 1, source: f.old, destination: f.current, phase: 'prepared' }));
    assert.throws(() => resolveStateHome(undefined, f.parent), /incomplete/);
    const result = migrate(f.parent); assert.equal(result.status, 0, result.stderr);
    assert.equal(resolveStateHome(undefined, f.parent), f.current);
    const record = join(f.current, 'state-migration.json');
    writeFileSync(record, JSON.stringify({ schemaVersion: 1, source: f.old, destination: f.current, phase: 'prepared' }));
    assert.throws(() => resolveStateHome(undefined, f.parent), /incomplete/);
    assert.equal(migrate(f.parent).status, 0);
  } finally { f.close(); }
});

test('migration updates only the owned login-service home and log paths', () => {
  const f = fixture();
  try {
    const directory = join(f.parent, 'Library/LaunchAgents'); mkdirSync(directory, { recursive: true });
    const plist = join(directory, 'org.the-fleet.service.plist');
    writeFileSync(plist, `<?xml version="1.0"?><plist version="1.0"><dict>
      <key>Label</key><string>org.the-fleet.service</string>
      <key>ProgramArguments</key><array><string>/custom/node</string></array>
      <key>EnvironmentVariables</key><dict><key>THE_FLEET_HOME</key><string>${f.old}</string><key>KEEP</key><string>/custom/value</string></dict>
      <key>StandardOutPath</key><string>${f.old}/service.log</string>
      <key>StandardErrorPath</key><string>/external/unchanged.log</string>
    </dict></plist>`, { mode: 0o600 });
    const result = migrate(f.parent); assert.equal(result.status, 0, result.stderr);
    const read = spawnSync('python3', ['-c', 'import plistlib,json,sys; print(json.dumps(plistlib.load(open(sys.argv[1],"rb"))))', plist], { encoding: 'utf8' });
    const value = JSON.parse(read.stdout);
    assert.deepEqual(value.ProgramArguments, ['/custom/node']);
    assert.deepEqual(value.EnvironmentVariables, { THE_FLEET_HOME: f.current, KEEP: '/custom/value' });
    assert.equal(value.StandardOutPath, join(f.current, 'service.log'));
    assert.equal(value.StandardErrorPath, '/external/unchanged.log');
    assert.equal(statSync(plist).mode & 0o777, 0o600);
  } finally { f.close(); }
});

test('failed pointer conversion keeps the journal and allows repair then resume', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.old, 'settings.json'), 'broken JSON');
    assert.equal(migrate(f.parent).status, 2);
    assert.ok(existsSync(join(f.current, 'settings.json')));
    assert.throws(() => resolveStateHome(undefined, f.parent), /incomplete/);
    writeFileSync(join(f.current, 'settings.json'), '{"schemaVersion":1}');
    const resumed = migrate(f.parent); assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(resolveStateHome(undefined, f.parent), f.current);
  } finally { f.close(); }
});

test('actual coordinator ownership prevents migration until it has stopped', { timeout: 30_000 }, async () => {
  const f = fixture();
  let paths = resolveStatePaths({ THE_FLEET_HOME: f.old });
  try {
    await ensureService(paths);
    assert.equal(migrate(f.parent).status, 2, 'a live coordinator owns the state');
    assert.ok(existsSync(f.old));
    await callApi(paths, 'POST', '/v1/stop', {});
    // Retry checks a real lock release, rather than assuming the response ended the process.
    let moved = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (migrate(f.parent).status === 0) { moved = true; break; }
      await new Promise<void>(done => setImmediate(done));
    }
    assert.ok(moved);
    paths = resolveStatePaths({ THE_FLEET_HOME: f.old });
    assert.equal(paths.home, f.current);
    await ensureService(paths);
    assert.equal((await callApi(paths, 'GET', '/v1/health'))['application'], 'The Fleet');
  } finally {
    await callApi(paths, 'POST', '/v1/stop', {}).catch(() => {});
    // Acquire the parent lock before deleting a fixture used by a child launcher.
    const child = spawn('python3', ['-B', '-c', 'import fcntl,sys; f=open(sys.argv[1],"a+"); fcntl.flock(f,fcntl.LOCK_EX)', join(f.parent, '.the-fleet-migration.lock')]);
    await new Promise<void>(done => child.once('exit', () => done()));
    f.close();
  }
});

test('bootstrap refuses to create another state home during the migration lock', { timeout: 10_000 }, async () => {
  const f = fixture();
  const holder = spawn('python3', ['-B', '-c', 'import fcntl,sys; f=open(sys.argv[1],"a+"); fcntl.flock(f,fcntl.LOCK_EX); print("locked",flush=True); sys.stdin.read()', join(f.parent, '.the-fleet-migration.lock')], { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await new Promise<void>(done => holder.stdout.once('data', () => done()));
    const started = spawnSync('python3', ['-B', lock, process.execPath, cli, 'service', 'serve'], { env: { ...process.env, THE_FLEET_HOME: f.old }, timeout: 1000 });
    assert.equal(started.status, 0);
    assert.equal(existsSync(join(f.old, 'service.sock')), false);
  } finally {
    holder.stdin.end();
    await new Promise<void>(done => holder.once('exit', () => done()));
    f.close();
  }
});
