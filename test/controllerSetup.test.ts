// Controller setup contracts use isolated private state and disposable Git
// worktrees. No real worker, native sender or user's Git configuration is used.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { currentRunsDirectory, resolveRunPaths, resolveStatePaths } from '../src/paths.ts';
import { registerProject } from '../src/registry.ts';
import { resolveProject } from '../src/service/projectResolution.ts';
import { report, startServiceFixture, writeRun, type ServiceFixture } from './helpers/serviceFixture.ts';
import { AdmissionTransport } from './helpers/admissionTransport.ts';
import { testMachine } from './helpers/fixtures.ts';

const manifest = { schemaVersion: 1, id: 'workspace', sync: { include: ['a'] },
  profiles: { check: { description: 'controller fixture', kind: 'check', argv: ['true'], timeoutMinutes: 1 } } };
const run = promisify(execFile);

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Fleet fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
}

function repo(f: ServiceFixture) {
  const main = join(f.root, 'main'); mkdirSync(main);
  git(main, 'init', '-q');
  writeFileSync(join(main, 'the-fleet.json'), JSON.stringify(manifest));
  writeFileSync(join(main, 'a'), 'input');
  git(main, 'add', '.'); git(main, 'commit', '-qm', 'Fixture');
  registerProject(f.paths, join(main, 'the-fleet.json'), main, false);
  const worktree = join(f.root, 'current'); git(main, 'worktree', 'add', '-q', '-b', 'current', worktree);
  return { main: realpathSync(main), worktree: realpathSync(worktree) };
}

test('project resolution returns null only for an unregistered current workspace', async () => {
  const f = await startServiceFixture();
  try {
    assert.deepEqual(await resolveProject(f.paths, { source: f.root }), { project: null });
    assert.equal((await f.call('POST', '/v1/projects/resolve', { source: '/missing/fleet-source' })).status, 400);
    assert.equal((await f.call('POST', '/v1/projects/resolve', { source: f.root, manifestPath: 12 })).status, 400);
  } finally { await f.close(); }
});

test('a custom registered recipe keeps its name in a linked worktree', async () => {
  const f = await startServiceFixture();
  try {
    const { main, worktree } = repo(f);
    for (const root of [main, worktree]) {
      mkdirSync(join(root, 'recipes'));
      writeFileSync(join(root, 'recipes', 'custom.json'), JSON.stringify(manifest));
      writeFileSync(join(root, 'the-fleet.json'), JSON.stringify({ ...manifest, id: 'unrelated' }));
    }
    registerProject(f.paths, join(main, 'recipes', 'custom.json'), main, true);
    assert.equal((await resolveProject(f.paths, { source: worktree })).project?.manifestPath, join(worktree, 'recipes', 'custom.json'));
  } finally { await f.close(); }
});

test('registered linked worktree resolves its current uncommitted recipe and source', async () => {
  const f = await startServiceFixture();
  try {
    const { worktree } = repo(f);
    const recipe = join(worktree, 'the-fleet.json');
    writeFileSync(recipe, JSON.stringify({ ...manifest, description: 'Current uncommitted recipe' }));
    const previousGit = process.env['GIT_DIR'];
    process.env['GIT_DIR'] = join(f.root, 'not-the-current-repository');
    let result;
    try { result = await f.call('POST', '/v1/projects/resolve', { source: worktree, manifestPath: recipe }); }
    finally { if (previousGit === undefined) delete process.env['GIT_DIR']; else process.env['GIT_DIR'] = previousGit; }
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(result.body['project'], { id: 'workspace', sourceRoot: worktree, manifestPath: recipe });
    assert.match(readFileSync(recipe, 'utf8'), /Current uncommitted recipe/);
    const alias = join(f.root, 'alias'); symlinkSync(worktree, alias);
    assert.deepEqual((await resolveProject(f.paths, { source: alias })).project,
      { id: 'workspace', sourceRoot: worktree, manifestPath: recipe });
  } finally { await f.close(); }
});

test('the ordinary CLI resolves the current worktree through the shared service', async () => {
  const f = await startServiceFixture();
  try {
    const { worktree } = repo(f);
    const { stdout } = await run(process.execPath, [fileURLToPath(new URL('../bin/the-fleet.js', import.meta.url)),
      'project', 'resolve', '--source', worktree, '--manifest', join(worktree, 'the-fleet.json')],
    { env: { ...process.env, THE_FLEET_HOME: f.paths.home } });
    assert.deepEqual(JSON.parse(stdout).project, { id: 'workspace', sourceRoot: worktree, manifestPath: join(worktree, 'the-fleet.json') });
  } finally { await f.close(); }
});

test('missing or mismatched current recipe never falls back to registered main', async () => {
  const f = await startServiceFixture();
  try {
    const { main, worktree } = repo(f);
    rmSync(join(worktree, 'the-fleet.json'));
    await assert.rejects(resolveProject(f.paths, { source: worktree }), /Manifest not found/);
    await assert.rejects(resolveProject(f.paths, { source: worktree, manifestPath: join(main, 'the-fleet.json') }), /current source/);
    writeFileSync(join(worktree, 'the-fleet.json'), JSON.stringify({ ...manifest, id: 'other' }));
    await assert.rejects(resolveProject(f.paths, { source: worktree }), /registered as/);
  } finally { await f.close(); }
});

test('ambiguous registrations fail instead of silently choosing a project', async () => {
  const f = await startServiceFixture();
  try {
    const { main } = repo(f);
    const second = join(main, 'second.json'); writeFileSync(second, JSON.stringify({ ...manifest, id: 'second' }));
    registerProject(f.paths, second, main, false);
    await assert.rejects(resolveProject(f.paths, { source: main }), /More than one project/);
  } finally { await f.close(); }
});

test('controller preference is shared, revision checked and separate from worker inventory', async () => {
  const f = await startServiceFixture();
  try {
    const initial = await f.call('GET', '/v1/config');
    const settings = initial.body['controller']; assert.ok(settings && typeof settings === 'object' && 'revision' in settings);
    const folder = join(f.root, 'results.noindex'); mkdirSync(folder);
    const result = await f.call('PUT', '/v1/config/controller', { revision: settings.revision, runsDirectory: folder });
    assert.equal(result.status, 200, result.text);
    assert.equal(currentRunsDirectory(f.paths), folder);
    assert.equal(resolveStatePaths({ THE_FLEET_HOME: f.root }).runsDir, folder);
    assert.equal((await f.call('PUT', '/v1/config/controller', { revision: settings.revision, runsDirectory: null })).status, 409);
    assert.equal(result.body['revision'], initial.body['revision']);
    const current = result.body['controller']; assert.ok(current && typeof current === 'object' && 'revision' in current);
    assert.equal((await f.call('PUT', '/v1/config/controller', { revision: current.revision, runsDirectory: null })).status, 200);
    assert.equal(currentRunsDirectory(f.paths), f.paths.runsDir);
  } finally { await f.close(); }
});

test('unavailable configured results drive blocks writes while settings stay accessible', async () => {
  const f = await startServiceFixture();
  try {
    const folder = join(f.root, 'results.noindex'); mkdirSync(folder);
    const initial = (await f.call('GET', '/v1/config')).body['controller']; assert.ok(initial && typeof initial === 'object' && 'revision' in initial);
    assert.equal((await f.call('PUT', '/v1/config/controller', { revision: initial.revision, runsDirectory: folder })).status, 200);
    rmSync(folder, { recursive: true });
    await assert.rejects(resolveRunPaths(f.paths), /existing absolute/);
    const current = await f.call('GET', '/v1/config'); assert.equal(current.status, 200);
    assert.deepEqual(current.body['paths'], { home: f.paths.home, machinesFile: f.paths.machinesFile, runsDirectory: folder });
    assert.equal(resolveStatePaths({ THE_FLEET_HOME: f.root }).runsDir, folder);
  } finally { await f.close(); }
});

test('explicit request and environment destinations precede the controller preference', async () => {
  const f = await startServiceFixture();
  try {
    const folders = ['central', 'environment', 'request'].map(name => join(f.root, `${name}.noindex`));
    for (const folder of folders) mkdirSync(folder);
    const [central = '', environment = '', request = ''] = folders;
    writeFileSync(join(f.root, 'settings.json'), JSON.stringify({ schemaVersion: 1, runsDirectory: central }));
    const paths = resolveStatePaths({ THE_FLEET_HOME: f.root, THE_FLEET_RUNS_DIRECTORY: environment });
    assert.equal((await resolveRunPaths(paths)).runsDir, environment);
    assert.equal((await resolveRunPaths(paths, request)).runsDir, request);
  } finally { await f.close(); }
});

test('new submissions use the shared preference without restarting the service', async () => {
  const f = await startServiceFixture({
    notifyDiskSpace: () => {},
    transportFor: (_machine, home) => { const t = new AdmissionTransport(home); t.fingerprint = 'worker'; return t; },
    execute: async request => writeRun(request.paths.runsDir, request.jobId ?? 'controller-fixture', { project: 'workspace' }),
  });
  try {
    const config = await f.call('GET', '/v1/config');
    assert.equal((await f.call('POST', '/v1/machines', { revision: config.body['revision'], id: 'worker', target: 'Mac-Mini', limits: testMachine().limits })).status, 200);
    f.reports.set('Mac-Mini', report('worker'));
    const folder = join(f.root, 'results.noindex'); mkdirSync(folder);
    const controller = (await f.call('GET', '/v1/config')).body['controller']; assert.ok(controller && typeof controller === 'object' && 'revision' in controller);
    await f.call('PUT', '/v1/config/controller', { revision: controller.revision, runsDirectory: folder });
    writeFileSync(join(f.root, 'a'), 'input');
    const started = await f.call('POST', '/v1/submit', { cwd: f.root, request: { source: f.root, manifest, profile: 'check' } });
    assert.equal(started.status, 202, started.text);
    const deadline = Date.now() + 10000;
    let complete = false;
    while (Date.now() < deadline) {
      const current = await f.call('GET', `/v1/operations/${String(started.body['operationId'])}`);
      if (current.body['status'] === 'complete') { assert.equal(current.body['exitCode'], 0, current.text); complete = true; break; }
    }
    assert.ok(complete);
    assert.equal(f.executed[0]?.paths.runsDir, folder);
  } finally { await f.close(); }
});
