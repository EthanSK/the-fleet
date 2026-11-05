// A real local API on a temporary socket with controllable worker observations.
// Workers are never contacted: inspection returns the report set for each
// Agent Bridge target, and execution is supplied by the test.

import { request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Coordinator, type CoordinatorDependencies } from '../../src/service/coordinator.ts';
import { startApi, serviceSocket } from '../../src/service/server.ts';
import { resolveStatePaths, type StatePaths } from '../../src/paths.ts';
import { loadMachines } from '../../src/registry.ts';
import { defaultMachineNames } from '../../src/run/orderedMachines.ts';
import type { PreflightReport } from '../../src/run/preflight.ts';
import type { Receipt, RunAbort } from '../../src/run/receipt.ts';
import type { RunRequest, RunResult } from '../../src/run/runJob.ts';
import { loadAgentBridgeRoute } from '../../src/transport/agentBridgeConfig.ts';
import { LocalShellTransport } from './localShellTransport.ts';
import type { Machine } from '../../src/schema/machines.ts';
import type { Transport } from '../../src/transport/transport.ts';
import type { DiskSpaceNotificationSender } from '../../src/service/diskNotifications.ts';

export const BRIDGE_CONFIG = [
  '[Mac-Mini]', 'host=192.0.2.10', 'user=tester', 'port=22', 'identity_file=/tmp/fleet-test-key', 'paired_at=2026-10-01',
  '[Ethans-Mac-mini]', 'host=192.0.2.10', 'user=tester',
  '[OldMacBookPro]', 'host=192.0.2.11', 'internet_host=100.64.0.11', 'user=tester',
  '[Broken]', 'user=tester',
  '',
].join('\n');

export function report(fingerprint: string, overrides: Partial<PreflightReport> = {}): PreflightReport {
  return { complete: true, fingerprint, rootExists: true, guiSession: true, bsdtar: true, missingBaseTools: [], tools: new Map(),
    heavy: [], lock: { state: 'free' }, cpuCount: 10, loadAverage: [1, 1, 1], ...overrides };
}

export interface ApiReply { status: number; body: Record<string, unknown>; text: string }

export function rawCall(paths: StatePaths, method: string, path: string, value?: unknown): Promise<ApiReply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath: serviceSocket(paths), method, path, headers: { 'content-type': 'application/json', connection: 'close' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown>, text }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end(value === undefined ? undefined : JSON.stringify(value));
  });
}

/** Writes a finished run folder the way runProfile does, and returns its result. */
export function writeRun(runsDirectory: string, jobId: string, options: { outcome?: Receipt['outcome']; abort?: RunAbort; project?: string; profile?: string; machine?: string; stdout?: string; finishedAt?: string; resources?: Receipt['resources']; placement?: Receipt['placement'] } = {}): RunResult {
  const directory = join(runsDirectory, jobId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, '.fleet-run'), '');
  writeFileSync(join(directory, 'stdout.log'), options.stdout ?? 'ok\n');
  writeFileSync(join(directory, 'stderr.log'), '');
  const outcome = options.outcome ?? 'passed';
  const finishedAt = options.finishedAt ?? new Date().toISOString();
  const receipt: Receipt = {
    schemaVersion: 1, jobId, project: options.project ?? 'example', profile: options.profile ?? 'test', profileKind: 'test', outcome,
    abort: options.abort ?? null,
    ...(options.resources === undefined ? {} : { resources: options.resources }),
    ...(options.placement === undefined ? {} : { placement: options.placement }),
    cliExitCode: { passed: 0, failed: 1, aborted: 2, refused: 4, error: 5, 'timed-out': 6, cancelled: 7 }[outcome], summary: `${outcome === 'passed' ? 'Passed' : 'Failed'} on ${options.machine ?? 'mini'}: 3 tests, exit 0`,
    machine: { id: options.machine ?? 'mini', transport: 'test', fingerprint: 'fp-mini' },
    source: { root: '/tmp/source', digest: 'a'.repeat(64), files: 3, symlinks: 0, bytes: 30, git: null, manifest: 'source-manifest.tsv' },
    command: { argv: ['npm', 'test'], extraArgs: [], prepare: [], cwd: '.', envNames: [], timeoutSeconds: 60, script: 'command.sh' },
    timing: { requestedAt: finishedAt, remoteStartedAt: finishedAt, remoteEndedAt: finishedAt, finishedAt, jobSeconds: 4, totalSeconds: 6 },
    remote: { admission: 'admitted', reason: 'completed', exitCode: 0, stragglersStopped: false, processesRemaining: false, lockReleased: true, notes: [] },
    success: { passed: outcome === 'passed', testCount: 3, checks: [{ name: 'tests', passed: outcome === 'passed', detail: '3 tests' }] },
    artifacts: [], missingArtifacts: [], logs: { stdout: 'stdout.log', stderr: 'stderr.log' },
  };
  const receiptPath = join(directory, 'receipt.json');
  writeFileSync(receiptPath, JSON.stringify(receipt));
  return { exitCode: receipt.cliExitCode, receipt, receiptPath, admission: 'admitted' };
}

export interface ServiceFixture {
  readonly root: string;
  readonly paths: StatePaths;
  readonly bridgeFile: string;
  /** Observation per Agent Bridge target: a report, or an Error for an unreachable worker. */
  readonly reports: Map<string, PreflightReport | Error>;
  readonly coordinator: Coordinator;
  readonly executed: RunRequest[];
  call(method: string, path: string, value?: unknown): Promise<ApiReply>;
  close(): Promise<void>;
}

export async function startServiceFixture(options: {
  execute?: (request: RunRequest) => Promise<RunResult>;
  abandonAfterMs?: number;
  sweepIntervalMs?: number;
  localFingerprint?: string;
  transportFor?: (machine: Machine, home: string) => Transport;
  notifyDiskSpace?: DiskSpaceNotificationSender;
  cleanupStale?: CoordinatorDependencies['cleanupStale'];
} = {}): Promise<ServiceFixture> {
  const root = mkdtempSync('/tmp/the-fleet-ui-');
  const paths = resolveStatePaths({ THE_FLEET_HOME: root });
  const bridgeFile = join(root, 'agent-bridge-config');
  writeFileSync(bridgeFile, BRIDGE_CONFIG);
  const reports = new Map<string, PreflightReport | Error>();
  const executed: RunRequest[] = [];
  const dependencies: CoordinatorDependencies = {
    machines: () => loadMachines(paths).machines,
    preferredMachine: () => defaultMachineNames(loadMachines(paths))[0],
    localFingerprint: async () => options.localFingerprint ?? 'fp-local',
    now: Date.now,
    inspect: async (machine) => {
      const observedAt = new Date().toISOString();
      const value = reports.get(machine.transport.target);
      if (value === undefined) return { machine, observedAt, error: `No route to ${machine.transport.target}` };
      if (value instanceof Error) return { machine, observedAt, error: value.message };
      return { machine, observedAt, report: value };
    },
    route: (machine) => loadAgentBridgeRoute(machine.transport.target, bridgeFile),
    execute: async (request) => {
      executed.push(request);
      if (!options.execute) throw new Error('Execution is not part of this test.');
      return options.execute(request);
    },
    ...(options.cleanupStale ? { cleanupStale: options.cleanupStale } : {}),
  };
  const coordinator = new Coordinator(paths, dependencies);
  const api = startApi(paths, coordinator, {
    transportFor: (machine) => options.transportFor?.(machine, root) ?? new LocalShellTransport(root),
    route: (target) => loadAgentBridgeRoute(target, bridgeFile),
    bridgeConfigPath: () => bridgeFile,
    ...(options.abandonAfterMs === undefined ? {} : { abandonAfterMs: options.abandonAfterMs }),
    ...(options.sweepIntervalMs === undefined ? {} : { sweepIntervalMs: options.sweepIntervalMs }),
    ...(options.notifyDiskSpace ? { notifyDiskSpace: options.notifyDiskSpace } : {}),
  });
  await new Promise<void>((done) => api.server.listen(serviceSocket(paths), done));
  return {
    root, paths, bridgeFile, reports, coordinator, executed,
    call: (method, path, value) => rawCall(paths, method, path, value),
    close: async () => { await api.shutdown(); rmSync(root, { recursive: true, force: true }); },
  };
}
