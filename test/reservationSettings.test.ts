// A settings save may finish while an external client's worker probe waits.
// Never grant ownership using the connection or folder that was superseded.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { Coordinator } from '../src/service/coordinator.ts';
import { resolveStatePaths } from '../src/paths.ts';
import { loadMachines, saveMachines } from '../src/registry.ts';
import type { Machine } from '../src/schema/machines.ts';
import { report } from './helpers/serviceFixture.ts';
import { testMachine } from './helpers/fixtures.ts';

for (const change of ['connection', 'folder', 'removal', 'capacity'] as const) {
  test(`external reservation refuses ${change} changed during inspection`, async () => {
    const root = mkdtempSync('/tmp/fleet-reserve-settings-');
    const paths = resolveStatePaths({ THE_FLEET_HOME: root });
    const machine = testMachine();
    saveMachines(paths, { schemaVersion: 1, machines: [machine] });
    let release!: () => void;
    let inspected!: () => void;
    const waiting = new Promise<void>((resolve) => { inspected = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let routeReads = 0;
    const coordinator = new Coordinator(paths, {
      machines: () => loadMachines(paths).machines,
      localFingerprint: async () => 'local', now: Date.now,
      inspect: async (value) => {
        inspected(); await gate;
        return { machine: value, observedAt: new Date().toISOString(), report: report('worker') };
      },
      route: (value) => {
        routeReads += 1;
        return { target: value.transport.target, host: '192.0.2.1', user: 'test', port: 22, path: 'lan' };
      },
      execute: async () => { throw new Error('reservation must not run a job'); },
    });
    try {
      const pending = coordinator.reserve('app', 'own SSH', [machine.id]);
      await waiting;
      const changed: Machine = change === 'connection'
        ? { ...machine, transport: { ...machine.transport, target: 'NewTarget' } }
        : change === 'capacity' ? { ...machine, limits: { ...machine.limits, maxConcurrentJobs: 2 } }
        : { ...machine, remoteRoot: '~/Changed.noindex' };
      saveMachines(paths, { schemaVersion: 1, machines: change === 'removal' ? [] : [changed] });
      coordinator.forget(machine.id);
      release();
      await assert.rejects(pending, /settings changed.*Nothing was reserved/);
      assert.equal(routeReads, 0, 'never return the stale connection');
      assert.equal(coordinator.reservationById('unused'), undefined);
      const state = await coordinator.state() as { reservations: unknown[] };
      assert.deepEqual(state.reservations, [], 'rejected inspection leaves no stranded ownership');
    } finally { release(); rmSync(root, { recursive: true, force: true }); }
  });
}
