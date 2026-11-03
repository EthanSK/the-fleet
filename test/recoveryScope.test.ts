// Recovering one worker from its detail view must leave other workers alone.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadMachines } from '../src/registry.ts';
import { inlineProject } from '../src/service/server.ts';
import { CapturedStream } from './helpers/fixtures.ts';
import { LocalShellTransport } from './helpers/localShellTransport.ts';
import { report, startServiceFixture } from './helpers/serviceFixture.ts';

test('worker-scoped recovery preserves another idle worker reservation', async () => {
  const fixture = await startServiceFixture({ execute: async () => { throw new Error('lost result'); } });
  try {
    for (const [id, target] of [['mini', 'Mac-Mini'], ['laptop', 'OldMacBookPro']]) {
      const revision = (await fixture.call('GET', '/v1/config')).body['revision'];
      assert.equal((await fixture.call('POST', '/v1/machines', { revision, id, target })).status, 200);
    }
    const machines = loadMachines(fixture.paths).machines;
    const project = inlineProject({ source: '.', files: ['source'], command: ['true'], timeoutMinutes: 1, kind: 'check' }, fixture.root);
    for (const machine of machines) {
      fixture.reports.set(machine.transport.target, report(machine.id, {
        lock: { state: 'busy', jobId: machine.id, label: 'uncertain result', orphaned: true },
      }));
      await assert.rejects(fixture.coordinator.runOne('test', `operation-${machine.id}`, {
        ...project, paths: fixture.paths, machine, transport: new LocalShellTransport(fixture.root),
        preflightReport: report(machine.id), extraArgs: [], ignoreHeavyProcesses: false,
        io: { stdout: new CapturedStream(), stderr: new CapturedStream(), status: () => {} },
      }), /lost result/);
    }
    for (const machine of machines) fixture.reports.set(machine.transport.target, report(machine.id));
    const selected = await fixture.call('POST', '/v1/recover?machine=mini');
    assert.deepEqual(selected.body['released'], ['operation-mini']);
    const state = (await fixture.call('GET', '/v1/state')).body as { reservations: { machineId: string }[] };
    assert.deepEqual(state.reservations.map((lease) => lease.machineId), ['laptop']);
    // Existing clients retain their explicit whole-fleet recovery operation.
    assert.deepEqual((await fixture.call('POST', '/v1/recover')).body['released'], ['operation-laptop']);
  } finally { await fixture.close(); }
});
