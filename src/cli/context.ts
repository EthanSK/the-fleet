// Shared state for CLI commands: state paths, output streams, the transport
// factory and the Ctrl-C bridge. Tests build their own context with an
// in-memory output and a local-shell transport.

import type { Writable } from 'node:stream';
import type { StatePaths } from '../paths.ts';
import type { Interrupts } from '../run/runJob.ts';
import type { Machine } from '../schema/machines.ts';
import type { Transport } from '../transport/transport.ts';
import type { RunRequest, RunResult } from '../run/runJob.ts';
import type { DiskSpaceProblemHandler } from '../run/diskSpace.ts';
import type { OrderedRunRequest } from '../run/orderedMachines.ts';

export interface CliContext {
  readonly paths: StatePaths;
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly transportFor: (machine: Machine) => Transport;
  readonly interrupts: Interrupts;
  /** The Fleet coordinator adds one shared admission gate across local clients. */
  readonly runOne?: (request: RunRequest) => Promise<RunResult | null>;
  readonly beforePreflight?: (machine: Machine) => Promise<void>;
  readonly selectionUsage?: OrderedRunRequest['selectionUsage'];
  readonly onDiskSpaceProblem?: DiskSpaceProblemHandler;
}

/** Plain result output on stdout. */
export function print(context: CliContext, line = ''): void {
  context.stdout.write(`${line}\n`);
}

/** Runner status on stderr, prefixed so it stands apart from job output. */
export function status(context: CliContext, line: string): void {
  context.stderr.write(`fleet-runner: ${line}\n`);
}

export function homeRelative(path: string): string {
  const home = process.env['HOME'];
  return home && path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}
