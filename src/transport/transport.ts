// Transport abstraction: start one remote shell command with piped stdio.
//
// Everything Fleet Runner does remotely goes through `start`, given one
// already-quoted POSIX command string (see shellQuote.ts). The real
// implementation is ssh over Agent Bridge's route (sshTransport.ts). Tests use
// a transport that runs the same command string with /bin/sh on this Mac, so
// the actual remote scripts (lock, supervisor, cleanup) are exercised
// end-to-end without a network. There is deliberately no "local" machine
// kind: a failed remote run never falls back to running here.

import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { FleetError } from '../errors.ts';

export interface RemoteExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface RemoteProcess {
  /** Local transport process identity, for reclaiming abandoned local staging. */
  readonly pid?: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<RemoteExit>;
  kill(signal?: NodeJS.Signals): void;
}

export interface Transport {
  /** Human description without addresses, e.g. "Agent Bridge target Mac-Mini (internet route)". */
  readonly description: string;
  start(remoteCommand: string): RemoteProcess;
  /** Rsync uses this same paired SSH route, with a guarded remote receiver. */
  startRsync?(sourceDirectory: string, receiverCommand: string): RemoteProcess;
  /** True when a failed process's stderr shows the connection itself failed. */
  isConnectionFailure(exit: RemoteExit, stderr: string): boolean;
}

export function wrapChild(child: ChildProcessByStdio<Writable, Readable, Readable>): RemoteProcess {
  const exited = new Promise<RemoteExit>((resolve) => {
    child.once('error', () => resolve({ code: 255, signal: null }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  // A remote side that stops reading must not crash this process with EPIPE.
  child.stdin.on('error', () => undefined);
  return {
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
    kill: (signal: NodeJS.Signals = 'SIGTERM') => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    },
  };
}

export interface CapturedResult {
  readonly exit: RemoteExit;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a short remote command and collects its output (preflight, status, control). */
export async function runCaptured(transport: Transport, command: string, options: { input?: string; timeoutMs: number }): Promise<CapturedResult> {
  const process = transport.start(command);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  process.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  process.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  process.stdin.end(options.input ?? '');
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    process.kill('SIGTERM');
  }, options.timeoutMs);
  const exit = await process.exited;
  clearTimeout(timer);
  const result = { exit, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
  if (timedOut) throw new FleetError('transport', `${transport.description} did not answer within ${Math.round(options.timeoutMs / 1000)}s.`);
  if (exit.code !== 0 && transport.isConnectionFailure(exit, result.stderr)) {
    throw new FleetError('transport', `Can't reach ${transport.description}.`, firstLines(result.stderr, 3));
  }
  return result;
}

export function firstLines(text: string, count: number): string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '').slice(0, count);
}
