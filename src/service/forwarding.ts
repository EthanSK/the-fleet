// Reservation-owned loopback port forwards.
//
// An external client that reserved a worker can ask the coordinator to hold
// `ssh -N -L` forwards from this computer's 127.0.0.1 to the worker's
// 127.0.0.1. The coordinator owns the ssh child, so the forwards outlive the
// client's CLI and browser sessions and end only on release, an explicit stop
// or a service restart. Nothing listens outside loopback on either end, and
// there is no remote daemon: a forward is one ssh session, nothing else.
//
// Readiness comes from ssh after it binds its own listeners. Whether the service
// behind a remote port answers is the owning app's health check, not the
// coordinator's: a forward to a stopped emulator is still a working forward.

import { FleetError } from '../errors.ts';
import { Reader } from '../schema/validate.ts';
import { FORWARDING_READY } from '../transport/sshTransport.ts';
import type { PortForward, RemoteProcess } from '../transport/transport.ts';

export type ForwardingState = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'stopped';

/** What /v1/state shows beside a reservation; never the ssh command or route. */
export interface PublicForwarding {
  readonly state: ForwardingState;
  readonly forwards: readonly PortForward[];
  readonly startedAt: string;
  /** ssh sessions started so far, including reconnections. */
  readonly attempts: number;
  /** Why the last session ended or could not start. */
  readonly detail?: string;
}

export interface ForwardingOptions {
  readonly now: () => number;
  /** How long the local listeners may take to accept after ssh starts. */
  readonly readyTimeoutMs?: number;
  /** First reconnection delay; later ones double up to a minute. */
  readonly retryDelayMs?: number;
}

const MAX_FORWARDS = 64;
const MAX_RETRY_DELAY_MS = 60_000;

/** Validates a client's `forwards` request body: unique unprivileged local ports, valid remote ports. */
export function parseForwards(value: unknown): PortForward[] {
  const reader = new Reader('forwards');
  const items = reader.array(value, { minLength: 1 });
  if (items.length > MAX_FORWARDS) reader.fail(`at most ${MAX_FORWARDS} forwards`);
  const seen = new Set<number>();
  return items.map((item, index) => {
    const child = reader.child(index);
    const raw = child.object(item, ['localPort', 'remotePort']);
    const localPort = child.child('localPort').number(raw['localPort'], { integer: true, min: 1024, max: 65535 });
    const remotePort = child.child('remotePort').number(raw['remotePort'], { integer: true, min: 1, max: 65535 });
    if (seen.has(localPort)) child.child('localPort').fail(`${localPort} is listed twice`);
    seen.add(localPort);
    return { localPort, remotePort };
  });
}

/** One reservation's forwards: starts ssh, proves the listeners, reconnects after a drop, stops on request. */
export class PortForwarding {
  readonly forwards: readonly PortForward[];
  private readonly spawn: () => RemoteProcess;
  private readonly readyTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly startedAt: string;
  private process: RemoteProcess | undefined;
  private state: ForwardingState = 'connecting';
  private detail: string | undefined;
  private attempts = 0;
  private reconnections = 0;
  private stopRequested = false;
  private retryTimer: NodeJS.Timeout | undefined;
  private startResult: Promise<PublicForwarding> | undefined;
  private stopResult: Promise<void> | undefined;

  constructor(forwards: readonly PortForward[], spawn: () => RemoteProcess, options: ForwardingOptions) {
    this.forwards = forwards;
    this.spawn = spawn;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
    this.retryDelayMs = options.retryDelayMs ?? 5_000;
    this.startedAt = new Date(options.now()).toISOString();
  }

  view(): PublicForwarding {
    return {
      state: this.state, forwards: this.forwards, startedAt: this.startedAt, attempts: this.attempts,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
    };
  }

  /**
   * First session. A session that never becomes ready is a plain failure for
   * the caller to read and fix (wrong port, worker unreachable); only an
   * established session that later drops is reconnected automatically.
   */
  start(): Promise<PublicForwarding> {
    this.startResult ??= this.attempt().then((ready) => {
      if (ready) return this.view();
      if (!this.stopRequested) this.state = 'failed';
      throw new FleetError('transport', `Port forwarding did not become ready. ${this.detail ?? 'The session was stopped.'}`);
    });
    return this.startResult;
  }

  /** Ends the session and waits for ssh to exit, so its local ports are free for the next owner. */
  stop(): Promise<void> {
    this.stopRequested = true;
    if (this.retryTimer !== undefined) { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
    const process = this.process;
    this.stopResult ??= (process === undefined ? Promise.resolve() : this.terminate(process)).then(() => {
      this.process = undefined;
      this.state = 'stopped';
    });
    return this.stopResult;
  }

  private async terminate(process: RemoteProcess): Promise<void> {
    const timeout = setTimeout(() => process.kill('SIGKILL'), 5_000); // Bound shutdown when an SSH child ignores SIGTERM.
    try {
      process.kill('SIGTERM');
      await process.exited;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async attempt(): Promise<boolean> {
    this.attempts += 1;
    let process: RemoteProcess;
    try {
      process = this.spawn();
    } catch {
      this.detail = 'The local SSH process could not start.';
      return false;
    }
    this.process = process;
    process.stdin.end();
    let portInUse = false;
    let output = '';
    let markReady: () => void = () => undefined;
    const ready = new Promise<'ready'>((resolve) => { markReady = () => resolve('ready'); });
    const onOutput = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-4_000);
      if (output.split(/\r?\n/).includes(FORWARDING_READY)) markReady();
    };
    process.stdout.on('data', onOutput);
    process.stderr.on('data', (chunk: Buffer) => { portInUse ||= chunk.toString('utf8').includes('Address already in use'); });
    let timeout: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      ready,
      process.exited.then(() => 'exited' as const),
      new Promise<'timed-out'>((resolve) => { timeout = setTimeout(() => resolve('timed-out'), this.readyTimeoutMs); }),
    ]);
    clearTimeout(timeout);
    process.stdout.off('data', onOutput).resume();
    if (this.stopRequested) return false;
    if (result === 'ready') {
      this.state = 'connected';
      this.detail = undefined;
      void process.exited.then(() => this.onSessionEnded(process));
      return true;
    }
    if (result === 'timed-out') await this.terminate(process);
    this.process = undefined;
    this.detail = portInUse ? 'A local port is already in use.' : result === 'exited'
      ? 'SSH exited before it opened the forwards.' : 'SSH did not open the forwards in time.';
    return false;
  }

  /** A dropped link (sleep, Tailscale blip, worker reboot) reconnects with bounded backoff while the owner keeps the forwards. */
  private onSessionEnded(process: RemoteProcess): void {
    if (this.process !== process || this.stopRequested) return;
    this.process = undefined;
    this.state = 'reconnecting';
    this.detail = 'SSH session ended.';
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const wait = Math.min(MAX_RETRY_DELAY_MS, this.retryDelayMs * 2 ** Math.min(this.reconnections, 4));
    this.reconnections += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.stopRequested) return;
      void this.attempt().then((ready) => {
        if (this.stopRequested) return;
        if (ready) { this.reconnections = 0; return; }
        this.state = 'reconnecting';
        this.scheduleReconnect();
      });
    }, wait);
    this.retryTimer.unref();
  }
}
