// Exercise external work-root identity, settings ownership and backing-space
// handling. Native missing-mount checks never create a directory; successful
// fixtures mock only volume identity, as the archive helper tests do. — GPT-6.1 Sol
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { serializeMachines } from '../src/registry.ts';
import { supervisorCommand } from '../src/remote/remoteScripts.ts';
import { evaluatePreflight } from '../src/run/preflight.ts';
import { parseMachines, type RootVolume } from '../src/schema/machines.ts';
import { testEnvironment, testMachine } from './helpers/fixtures.ts';
import { report, startServiceFixture } from './helpers/serviceFixture.ts';

test('an external root round-trips its work and backing identities and rejects paths outside the mount', () => {
  const rootVolume: RootVolume = { mountPoint: '/Volumes/Builds.noindex', volumeUuid: 'work-uuid', backingVolume: { mountPoint: '/Volumes/External', volumeUuid: 'backing-uuid' } };
  const machine = testMachine({ remoteRoot: '/Volumes/Builds.noindex/worker.noindex', rootVolume });
  const value = { schemaVersion: 1, machines: [machine] };
  const parsed = parseMachines(value, 'fixture');
  assert.deepEqual(parseMachines(serializeMachines(parsed), 'roundtrip').machines[0]?.rootVolume, rootVolume);
  for (const invalid of [{ ...machine, remoteRoot: '/tmp/outside.noindex' }, { ...machine, rootVolume: { ...rootVolume, mountPoint: '/Volumes/x/../y' } }, { ...machine, rootVolume: { ...rootVolume, backingVolume: { mountPoint: '/', volumeUuid: 'backing-uuid' } } }]) {
    assert.throws(() => parseMachines({ ...value, machines: [invalid] }, 'fixture'));
  }
});

test('the actual native wrapper rejects a missing volume before creating the supervisor root', async () => {
  const fixture = testEnvironment();
  const mountPoint = join(fixture.root, 'missing-volume');
  const root = join(mountPoint, 'worker.noindex');
  const machine = testMachine({ remoteRoot: root, rootVolume: { mountPoint, volumeUuid: 'missing-uuid' } });
  try {
    await assert.rejects(execute('/bin/sh', ['-c', supervisorCommand(machine, { jobId: 'volume-refusal', nonce: 'nonce', timeoutSeconds: 10, label: 'Volume refusal' })]), (error: unknown) => {
      assert.ok(error instanceof Error && 'code' in error && 'stderr' in error);
      assert.equal(error.code, 73);
      assert.match(String(error.stderr), /volume is not mounted/);
      return true;
    });
    assert.equal(existsSync(mountPoint), false);
    assert.equal(existsSync(root), false);
  } finally { fixture.cleanup(); }
});

test('work-volume API edits retain unrelated settings and refuse changes while reserved', async () => {
  const fixture = await startServiceFixture();
  const revision = async () => String((await fixture.call('GET', '/v1/config')).body['revision']);
  const rootVolume = { mountPoint: '/Volumes/Builds.noindex', volumeUuid: 'work-uuid' };
  try {
    const added = await fixture.call('POST', '/v1/machines', { revision: await revision(), id: 'mini', target: 'Mac-Mini', remoteRoot: '/Volumes/Builds.noindex/worker.noindex', rootVolume });
    assert.equal(added.status, 200, added.text);
    const unrelated = await fixture.call('PUT', '/v1/machines/mini', { revision: await revision(), description: 'External builds' });
    assert.equal(unrelated.status, 200, unrelated.text);
    assert.deepEqual((unrelated.body['machine'] as Record<string, unknown>)['rootVolume'], rootVolume);
    fixture.reports.set('Mac-Mini', report('fp-mini'));
    const lease = await fixture.call('POST', '/v1/reservations', { owner: 'fixture', label: 'Volume fixture', machines: ['mini'] });
    assert.equal(lease.status, 200, lease.text);
    const busy = await fixture.call('PUT', '/v1/machines/mini', { revision: await revision(), rootVolume: { ...rootVolume, volumeUuid: 'different-uuid' } });
    assert.equal(busy.status, 409, busy.text);
  } finally { await fixture.close(); }
});

test('an external job disk cannot hide a full or unobserved macOS internal disk', () => {
  const base = testMachine();
  const machine = testMachine({ remoteRoot: '/Volumes/Builds.noindex/worker.noindex', rootVolume: { mountPoint: '/Volumes/Builds.noindex', volumeUuid: 'work-uuid' }, limits: { ...base.limits, minFreeDiskGiB: 8 } });
  const options = { ignoreHeavyProcesses: false, nowEpoch: 1 };
  const external = { os: 'Darwin', diskFreeBytes: 100 * 1024 ** 3 };
  assert.ok(evaluatePreflight(report('fp-mini', { ...external, swapDiskFreeBytes: 1024 ** 3 }), machine, undefined, options).refusals.some((finding) => finding.kind === 'disk'));
  assert.ok(evaluatePreflight(report('fp-mini', external), machine, undefined, options).refusals.some((finding) => finding.kind === 'incomplete'));
  assert.equal(evaluatePreflight(report('fp-mini', { ...external, swapDiskFreeBytes: 30 * 1024 ** 3 }), machine, undefined, options).refusals.length, 0);
});

test('the wrapper pins both identities and reports physical backing space after observation', async () => {
  const fixture = testEnvironment();
  const mountPoint = join(fixture.root, 'mounted');
  const backing = join(fixture.root, 'backing');
  mkdirSync(mountPoint); mkdirSync(backing);
  const root = join(mountPoint, 'worker.noindex');
  const settings = { mountPoint, volumeUuid: 'work-uuid', minFreeGiB: 8, backingVolume: { mountPoint: backing, volumeUuid: 'backing-uuid' } };
  // Keep the real wrapper and subprocess/file-descriptor lifecycle; replace
  // only the device observation, like largeScratchHelper.py. — GPT-6.1 Sol
  const owner = `import os\nfrom types import SimpleNamespace\nreal_space=os.fstatvfs\ndef volume_fd(cfg, required_bytes=0):\n if cfg['volumeUuid']=='wrong-uuid': raise ValueError('The large scratch volume identity does not match.')\n return os.open(cfg['mountPoint'], os.O_RDONLY|os.O_DIRECTORY)\ndef measured(fd):\n return SimpleNamespace(f_bavail=2048, f_frsize=1024) if os.fstat(fd).st_ino==os.stat(${JSON.stringify(backing)}).st_ino else real_space(fd)\nos.fstatvfs=measured\n`;
  try {
    const wrapper = fileURLToPath(new URL('../remote/root_volume.py', import.meta.url));
    const result = await execute('python3', [wrapper, root, 'observe', JSON.stringify(settings), owner, `python3 -c 'import os; os.fstat(198); os.fstat(197); print("pinned")'; printf 'disk_free_kb=9999999999\\n'`]);
    assert.match(result.stdout, /pinned/);
    assert.ok(result.stdout.trimEnd().endsWith('disk_free_kb=2048'), result.stdout);
    const wrong = { ...settings, backingVolume: { ...settings.backingVolume, volumeUuid: 'wrong-uuid' } };
    await assert.rejects(execute('python3', [wrapper, root, 'start', JSON.stringify(wrong), owner, `mkdir '${root}'`]), /identity does not match/);
    assert.equal(existsSync(root), false);
  } finally { fixture.cleanup(); }
});

test('low space blocks starts while cancellation and recovery keep their access path', async () => {
  const fixture = testEnvironment();
  const mountPoint = join(fixture.root, 'mounted'); mkdirSync(mountPoint);
  const settings = { mountPoint, volumeUuid: 'work-uuid', minFreeGiB: 8 };
  const owner = `import os\ndef volume_fd(cfg, required_bytes=0):\n if required_bytes: raise ValueError('The large scratch volume has insufficient free space.')\n return os.open(cfg['mountPoint'], os.O_RDONLY|os.O_DIRECTORY)\n`;
  const wrapper = fileURLToPath(new URL('../remote/root_volume.py', import.meta.url));
  const root = join(mountPoint, 'worker.noindex');
  try {
    await assert.rejects(execute('python3', [wrapper, root, 'start', JSON.stringify(settings), owner, `mkdir '${root}'`]), /insufficient free space/);
    assert.equal(existsSync(root), false);
    assert.equal((await execute('python3', [wrapper, root, 'access', JSON.stringify(settings), owner, 'printf access-ok'])).stdout, 'access-ok');
  } finally { fixture.cleanup(); }
});

const execute = promisify(execFile);
