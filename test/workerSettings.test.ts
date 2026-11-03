// Worker settings through the local API: Agent Bridge stays the source of
// connection details, machines.json the source of worker settings. Edits are
// revision-checked and must never re-point or re-root a worker that has work.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerProject, loadMachines } from '../src/registry.ts';
import { parsePreflight } from '../src/run/preflight.ts';
import { fetchPreflight } from '../src/run/remoteChecks.ts';
import { inlineProject } from '../src/service/server.ts';
import { report, startServiceFixture, writeRun, type ServiceFixture } from './helpers/serviceFixture.ts';
import { CapturedStream, testEnvironment, testMachine } from './helpers/fixtures.ts';
import { LocalShellTransport } from './helpers/localShellTransport.ts';

async function revision(f: ServiceFixture): Promise<string> {
  return String((await f.call('GET', '/v1/config')).body['revision']);
}

async function addMini(f: ServiceFixture, extra: Record<string, unknown> = {}): Promise<void> {
  const reply = await f.call('POST', '/v1/machines', { revision: await revision(f), id: 'mini', target: 'Mac-Mini', aliases: ['Ethans-Mac-mini'], ...extra });
  assert.equal(reply.status, 200, reply.text);
}

test('adding from a paired target keeps connection details in Agent Bridge and env values private', async () => {
  const f = await startServiceFixture();
  try {
    const pairings = await f.call('GET', '/v1/pairings');
    const targets = pairings.body['targets'] as Record<string, unknown>[];
    assert.deepEqual(targets.map((target) => target['target']), ['Mac-Mini', 'Ethans-Mac-mini', 'OldMacBookPro', 'Broken']);
    assert.equal(targets.find((target) => target['target'] === 'OldMacBookPro')?.['route'], 'internet');
    assert.equal(targets.find((target) => target['target'] === 'Broken')?.['usable'], false);
    assert.doesNotMatch(pairings.text, /fleet-test-key/, 'key paths are reported as present, never shown');
    assert.equal(targets[0]?.['keyConfigured'], true);

    await addMini(f, { env: { TOOL_TOKEN: 'secret-value' }, description: 'Desk Mini' });
    const config = await f.call('GET', '/v1/config');
    const [mini] = config.body['machines'] as Record<string, unknown>[];
    assert.equal(mini?.['isDefault'], true, 'the first worker becomes the default');
    assert.deepEqual(mini?.['envNames'], ['TOOL_TOKEN']);
    assert.doesNotMatch(config.text, /secret-value/);
    const saved = readFileSync(f.paths.machinesFile, 'utf8');
    assert.match(saved, /secret-value/); assert.doesNotMatch(saved, /192\.0\.2\.10/, 'hosts stay in the Agent Bridge pairing');

    const after = (await f.call('GET', '/v1/pairings')).body['targets'] as Record<string, unknown>[];
    assert.equal(after.find((target) => target['target'] === 'Ethans-Mac-mini')?.['registeredAs'], 'mini', 'an alias counts as registered');

    const current = await revision(f);
    assert.match((await f.call('POST', '/v1/machines', { revision: current, id: 'other', target: 'Nope' })).body['error'] as string, /no paired target/);
    assert.match((await f.call('POST', '/v1/machines', { revision: current, id: 'mini', target: 'OldMacBookPro' })).body['error'] as string, /already exists/);
    const collision = await f.call('POST', '/v1/machines', { revision: current, id: 'laptop', target: 'OldMacBookPro', aliases: ['ethans-mac-mini'] });
    assert.equal(collision.status, 400); assert.match(collision.body['error'] as string, /One physical machine needs one entry/);
    const stale = await f.call('POST', '/v1/machines', { revision: 'none', id: 'laptop', target: 'OldMacBookPro' });
    assert.equal(stale.status, 409); assert.equal(stale.body['code'], 'revision-conflict'); assert.equal(stale.body['revision'], current);
    assert.equal(loadMachines(f.paths).machines.length, 1);
  } finally { await f.close(); }
});

test('two edits from one view: the second is a conflict, and saved env values are kept without being read', async () => {
  const f = await startServiceFixture();
  try {
    await addMini(f, { env: { TOOL_TOKEN: 'secret-value' } });
    const seen = await revision(f);
    const first = await f.call('PUT', '/v1/machines/mini', { revision: seen, description: 'Desk Mini' });
    assert.equal(first.status, 200, first.text);
    const second = await f.call('PUT', '/v1/machines/mini', { revision: seen, limits: { keepJobs: 5 } });
    assert.equal(second.status, 409); assert.equal(second.body['code'], 'revision-conflict');
    assert.equal(loadMachines(f.paths).machines[0]?.limits.keepJobs, 20, 'the conflicting edit changed nothing');

    const kept = await f.call('PUT', '/v1/machines/mini', { revision: String(first.body['revision']), env: { TOOL_TOKEN: { keep: true }, NEW_TOOL: { value: '/opt/tool' } } });
    assert.equal(kept.status, 200, kept.text);
    assert.deepEqual(loadMachines(f.paths).machines[0]?.env, { TOOL_TOKEN: 'secret-value', NEW_TOOL: '/opt/tool' });
    assert.doesNotMatch(kept.text, /secret-value|\/opt\/tool/);
    const missing = await f.call('PUT', '/v1/machines/mini', { revision: String(kept.body['revision']), env: { ABSENT: { keep: true } } });
    assert.equal(missing.status, 400); assert.match(missing.body['error'] as string, /no saved value/);
    const invalid = await f.call('PUT', '/v1/machines/mini', { revision: String(kept.body['revision']), limits: { minFreeDiskGiB: -1 } });
    assert.equal(invalid.status, 400); assert.match(invalid.body['error'] as string, /at least 0/);
    const cleared = await f.call('PUT', '/v1/machines/mini', { revision: String(kept.body['revision']), env: {}, description: null, isDefault: false });
    assert.equal(cleared.status, 200, cleared.text);
    const saved = loadMachines(f.paths);
    assert.deepEqual(saved.machines[0]?.env, {}); assert.equal(saved.machines[0]?.description, undefined); assert.equal(saved.defaultMachine, undefined);
  } finally { await f.close(); }
});

test('connection and remote-folder changes wait for reservations and a verified free lock; limits do not', async () => {
  const f = await startServiceFixture();
  try {
    await addMini(f);
    f.reports.set('Mac-Mini', report('fp-mini'));
    const lease = await f.coordinator.reserve('agent', 'own SSH tests', ['mini']) as { reservation: { id: string }; token: string };
    const rerouted = await f.call('PUT', '/v1/machines/mini', { revision: await revision(f), target: 'OldMacBookPro' });
    assert.equal(rerouted.status, 409); assert.equal(rerouted.body['code'], 'busy'); assert.match(rerouted.body['error'] as string, /reserved by agent/);
    const limits = await f.call('PUT', '/v1/machines/mini', { revision: await revision(f), limits: { minFreeDiskGiB: 12 } });
    assert.equal(limits.status, 200, 'admission limits can change while work runs');
    assert.equal(loadMachines(f.paths).machines[0]?.transport.target, 'Mac-Mini');
    await f.coordinator.release(lease.reservation.id, lease.token);

    f.reports.set('Mac-Mini', report('fp-mini', { lock: { state: 'busy', jobId: 'job-1', label: 'other/test', orphaned: false } }));
    const busyRoot = await f.call('PUT', '/v1/machines/mini', { revision: await revision(f), remoteRoot: '~/Elsewhere.noindex' });
    assert.equal(busyRoot.status, 409); assert.match(busyRoot.body['error'] as string, /job lock/);
    f.reports.set('Mac-Mini', new Error('Connection timed out'));
    const unknownRoot = await f.call('PUT', '/v1/machines/mini', { revision: await revision(f), remoteRoot: '~/Elsewhere.noindex' });
    assert.equal(unknownRoot.status, 409); assert.match(unknownRoot.body['error'] as string, /Can't confirm/);
    assert.equal(loadMachines(f.paths).machines[0]?.remoteRoot, '~/FleetRunner.noindex');

    // An unreachable, unreserved worker can be re-pointed: that is how a broken route is fixed.
    const fixed = await f.call('PUT', '/v1/machines/mini', { revision: await revision(f), target: 'OldMacBookPro' });
    assert.equal(fixed.status, 200, fixed.text);
    f.reports.set('OldMacBookPro', report('fp-mini'));
    const moved = await f.call('PUT', '/v1/machines/mini', { revision: await revision(f), remoteRoot: '~/Elsewhere.noindex' });
    assert.equal(moved.status, 200, moved.text);
    assert.equal(loadMachines(f.paths).machines[0]?.remoteRoot, '~/Elsewhere.noindex');
  } finally { await f.close(); }
});

test('a run admitted with superseded settings never starts', async () => {
  const f = await startServiceFixture({ execute: async () => { throw new Error('must not execute'); } });
  try {
    await addMini(f);
    f.reports.set('Mac-Mini', report('fp-mini'));
    const project = inlineProject({ source: '.', files: ['a'], command: ['true'], timeoutMinutes: 1, kind: 'check' }, '/tmp');
    const stale = { ...loadMachines(f.paths).machines[0]!, remoteRoot: '~/Superseded.noindex' };
    await assert.rejects(f.coordinator.runOne('app', 'b'.repeat(24), { ...project, paths: f.paths, machine: stale, transport: new LocalShellTransport('/tmp'),
      extraArgs: [], ignoreHeavyProcesses: false, io: { stdout: new CapturedStream(), stderr: new CapturedStream(), status: () => {} } }), /settings changed/);
    assert.equal(f.executed.length, 0);
    assert.deepEqual((await f.call('GET', '/v1/state')).body['reservations'], [], 'the refused run left no ownership behind');
  } finally { await f.close(); }
});

test('removing a worker keeps its data, waits for its reservation and names projects that use it', async () => {
  const f = await startServiceFixture();
  try {
    await addMini(f);
    f.reports.set('Mac-Mini', report('fp-mini'));
    const source = join(f.root, 'project'); mkdirSync(source);
    writeFileSync(join(source, 'fleet.json'), JSON.stringify({ schemaVersion: 1, id: 'pinned', defaultMachine: 'Ethans-Mac-mini', sync: { include: ['fleet.json'] },
      profiles: { check: { description: 'Check', kind: 'check', argv: ['true'], timeoutMinutes: 1 } } }));
    registerProject(f.paths, join(source, 'fleet.json'), source, false);
    writeRun(f.paths.runsDir, '20261101-120000-pinned-check-abcdef');

    const lease = await f.coordinator.reserve('agent', 'tests', ['mini']) as { reservation: { id: string }; token: string };
    const refused = await f.call('DELETE', `/v1/machines/mini?revision=${await revision(f)}`);
    assert.equal(refused.status, 409); assert.match(refused.body['error'] as string, /Remove it after/);
    await f.coordinator.release(lease.reservation.id, lease.token);
    assert.equal((await f.call('DELETE', '/v1/machines/mini?revision=stale')).status, 409);
    const removed = await f.call('DELETE', `/v1/machines/mini?revision=${await revision(f)}`);
    assert.equal(removed.status, 200, removed.text);
    assert.match((removed.body['warnings'] as string[])[0] ?? '', /pinned names mini/);
    assert.deepEqual(loadMachines(f.paths), { schemaVersion: 1, machines: [] });
    assert.ok(existsSync(join(f.paths.runsDir, '20261101-120000-pinned-check-abcdef', 'receipt.json')), 'run history is untouched');
  } finally { await f.close(); }
});

test('checking a pairing reports identity matches without registering it', async () => {
  const f = await startServiceFixture({ localFingerprint: 'fp-local' });
  try {
    await addMini(f);
    f.reports.set('Mac-Mini', report('fp-mini'));
    f.reports.set('OldMacBookPro', report('fp-mini', { model: 'MacBookPro18,2' }));
    const before = await revision(f);
    const duplicate = await f.call('POST', '/v1/pairings/check', { target: 'OldMacBookPro' });
    assert.equal(duplicate.body['reachable'], true); assert.equal(duplicate.body['sameAs'], 'mini');
    f.reports.set('OldMacBookPro', report('fp-local'));
    assert.equal((await f.call('POST', '/v1/pairings/check', { target: 'OldMacBookPro' })).body['dispatchingComputer'], true);
    f.reports.set('OldMacBookPro', new Error('Connection timed out'));
    const offline = await f.call('POST', '/v1/pairings/check', { target: 'OldMacBookPro' });
    assert.equal(offline.body['reachable'], false); assert.match(offline.body['error'] as string, /timed out/);
    assert.equal((await f.call('POST', '/v1/pairings/check', { target: 'Broken' })).status, 400);
    assert.equal(await revision(f), before, 'checks never write settings');
  } finally { await f.close(); }
});

test('display hardware fields are parsed and the real preflight script reports them', async () => {
  const parsed = parsePreflight('model=Mac16,10\ncpu_brand=Apple M4\nos_version=26.1\nlock=free\ndone=1\n');
  assert.equal(parsed.model, 'Mac16,10'); assert.equal(parsed.cpuBrand, 'Apple M4'); assert.equal(parsed.osVersion, '26.1');
  const empty = parsePreflight('model=\ncpu_brand=\nlock=free\ndone=1\n');
  assert.equal(empty.model, undefined); assert.equal(empty.cpuBrand, undefined);
  const env = testEnvironment();
  try {
    const live = await fetchPreflight(env.transport, testMachine({ remoteRoot: env.remoteRoot }), [], []);
    assert.equal(live.complete, true);
    if (process.platform === 'darwin') {
      assert.match(live.model ?? '', /\S/); assert.match(live.cpuBrand ?? '', /\S/); assert.match(live.osVersion ?? '', /^\d+\.\d+/);
    }
  } finally { env.cleanup(); }
});
