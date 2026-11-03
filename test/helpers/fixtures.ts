// Shared test fixtures: temporary directories, manifests, machines and a CLI
// context with captured output. Every test writes only under its own mktemp
// directory, removed afterwards.

import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import type { CliContext } from '../../src/cli/context.ts';
import { resolveStatePaths, type StatePaths } from '../../src/paths.ts';
import { Interrupts } from '../../src/run/runJob.ts';
import { DEFAULT_LIMITS, type Machine } from '../../src/schema/machines.ts';
import { LocalShellTransport } from './localShellTransport.ts';

export function temporaryDirectory(prefix = 'fleet-runner-test-'): { path: string; cleanup: () => void } {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

export class CapturedStream extends Writable {
  chunks: Buffer[] = [];

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: () => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  get text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

export function testMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: 'mini',
    transport: { kind: 'agent-bridge', target: 'Mac-Mini' },
    aliases: ['Ethans-Mac-mini'],
    remoteRoot: '~/Fleet Runner.noindex',
    pathPrepend: [],
    env: {},
    limits: {
      ...DEFAULT_LIMITS,
      // Existing lifecycle fixtures qualify exclusive compatibility. Capacity
      // tests explicitly choose overlap and exercise both lock models.
      maxConcurrentJobs: 1,
      minFreeDiskGiB: 0,
      minAvailableMemoryGiB: 0,
      memoryPressure: 'report-only',
      // Other work on the test Mac (compilers from other chats) must not fail tests.
      heavyProcessAction: 'warn',
      terminateGraceSeconds: 1,
      uploadTimeoutMinutes: 1,
    },
    ...overrides,
  };
}

export interface TestEnvironment {
  readonly root: string;
  readonly paths: StatePaths;
  readonly remoteHome: string;
  readonly remoteRoot: string;
  readonly transport: LocalShellTransport;
  readonly stdout: CapturedStream;
  readonly stderr: CapturedStream;
  readonly context: CliContext;
  readonly cleanup: () => void;
}

export function testEnvironment(): TestEnvironment {
  const directory = temporaryDirectory();
  const paths = resolveStatePaths({ FLEET_RUNNER_HOME: join(directory.path, 'state') });
  const remoteHome = join(directory.path, 'remote home');
  mkdirSync(remoteHome, { recursive: true });
  const transport = new LocalShellTransport(remoteHome);
  const stdout = new CapturedStream();
  const stderr = new CapturedStream();
  const context: CliContext = { paths, stdout, stderr, transportFor: () => transport, interrupts: new Interrupts() };
  return {
    root: directory.path,
    paths,
    remoteHome,
    remoteRoot: join(remoteHome, 'Fleet Runner.noindex'),
    transport,
    stdout,
    stderr,
    context,
    cleanup: directory.cleanup,
  };
}

export function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = (): void => {
      if (condition()) return resolve(true);
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}
