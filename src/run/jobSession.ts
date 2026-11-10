// One supervisor ssh session, seen from this Mac.
//
// Wraps the RemoteProcess and SupervisorStreamParser: forwards job output,
// records protocol lines, writes a returned artifact archive to disk, and lets
// the run flow wait for specific protocol words with a timeout. Waiting stops
// with a transport error if the connection drops, so the caller never hangs on
// a dead session.

import { createWriteStream, type WriteStream } from 'node:fs';
import { FleetError } from '../errors.ts';
import { SupervisorStreamParser, type SupervisorEvent } from '../remote/supervisorStream.ts';
import { firstLines, type RemoteExit, type RemoteProcess, type Transport } from '../transport/transport.ts';

export interface ProtocolLine {
  readonly word: string;
  readonly rest: string;
}

export interface JobSessionHandlers {
  readonly onJobStdout: (data: Buffer) => void;
  readonly onStderr: (data: Buffer) => void;
  readonly onProtocol?: (line: ProtocolLine) => void;
}

export class JobSession {
  readonly lines: ProtocolLine[] = [];
  readonly exited: Promise<RemoteExit>;
  private cursor = 0;
  private waiter: { words: readonly string[]; resolve: (line: ProtocolLine) => void; reject: (error: Error) => void } | undefined;
  private readonly process: RemoteProcess;
  private readonly parser: SupervisorStreamParser;
  private readonly transport: Transport;
  private stderrTail = '';
  private exitedValue: RemoteExit | undefined;
  private artifactStream: WriteStream | undefined;
  private artifactPath: string | undefined;
  private artifactResolve: (() => void) | undefined;
  private artifactDone: Promise<void> | undefined;
  private artifactWriteError: Error | undefined;
  jobEnded = false;

  constructor(transport: Transport, command: string, nonce: string, handlers: JobSessionHandlers) {
    this.transport = transport;
    this.process = transport.start(command);
    this.parser = new SupervisorStreamParser(nonce, (event) => this.handleEvent(event, handlers));
    this.process.stdout.on('data', (chunk: Buffer) => this.parser.push(chunk));
    this.process.stdout.on('end', () => this.parser.end());
    this.process.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-4000);
      handlers.onStderr(chunk);
    });
    this.exited = this.process.exited.then((exit) => {
      this.exitedValue = exit;
      if (this.waiter) {
        const waiter = this.waiter;
        this.waiter = undefined;
        waiter.reject(this.connectionLostError(exit));
      }
      this.artifactResolve?.();
      return exit;
    });
  }

  /** Arms artifact capture: the next ARTIFACTS payload is written to this path. */
  captureArtifactsTo(path: string): void {
    this.artifactPath = path;
  }

  /** Resolves when the artifact archive has been fully written (or the session ended). */
  async artifactsWritten(): Promise<void> {
    await this.artifactDone;
    if (this.artifactWriteError) throw this.artifactWriteError;
  }

  send(line: string): void {
    if (this.exitedValue === undefined && this.process.stdin.writable) this.process.stdin.write(`${line}\n`);
  }

  closeInput(): void {
    if (this.process.stdin.writable) this.process.stdin.end();
  }

  kill(): void {
    this.process.kill('SIGTERM');
  }

  get isClosed(): boolean {
    return this.exitedValue !== undefined;
  }

  /** Waits for the next protocol line whose word is one of `words`. */
  waitFor(words: readonly string[], timeoutMs: number): Promise<ProtocolLine> {
    for (; this.cursor < this.lines.length; this.cursor += 1) {
      const line = this.lines[this.cursor];
      if (line && words.includes(line.word)) {
        this.cursor += 1;
        return Promise.resolve(line);
      }
    }
    if (this.exitedValue !== undefined) return Promise.reject(this.connectionLostError(this.exitedValue));
    return new Promise<ProtocolLine>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        reject(new TimeoutWaitingError(words));
      }, timeoutMs);
      this.waiter = {
        words,
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }

  /** All protocol lines with this word seen so far. */
  linesWith(word: string): ProtocolLine[] {
    return this.lines.filter((line) => line.word === word);
  }

  private handleEvent(event: SupervisorEvent, handlers: JobSessionHandlers): void {
    switch (event.type) {
      case 'protocol': {
        const line = { word: event.word, rest: event.rest };
        this.lines.push(line);
        handlers.onProtocol?.(line);
        if (this.waiter && this.waiter.words.includes(line.word)) {
          const waiter = this.waiter;
          this.waiter = undefined;
          this.cursor = this.lines.length;
          waiter.resolve(line);
        }
        if (line.word === 'ARTIFACTS') this.startArtifactCapture();
        return;
      }
      case 'job-stdout':
        handlers.onJobStdout(event.data);
        return;
      case 'job-end':
        this.jobEnded = true;
        return;
      case 'artifact-data':
        this.artifactStream?.write(event.data);
        return;
      case 'artifact-end':
        if (this.artifactStream) {
          const stream = this.artifactStream;
          this.artifactStream = undefined;
          stream.end(() => this.artifactResolve?.());
        } else {
          this.artifactResolve?.();
        }
        return;
      case 'noise':
        // Login-shell chatter before the protocol starts; keep it visible on stderr.
        handlers.onStderr(Buffer.from(`${event.line}\n`));
        return;
    }
  }

  private startArtifactCapture(): void {
    this.artifactDone = new Promise<void>((resolve) => {
      this.artifactResolve = resolve;
    });
    if (this.artifactPath !== undefined) {
      this.artifactStream = createWriteStream(this.artifactPath, { mode: 0o600 });
      // A full controller disk must fail this return and send NACK, rather
      // than crash the shared coordinator and abandon unrelated jobs.
      this.artifactStream.once('error', (error: Error) => {
        this.artifactWriteError = error;
        this.artifactStream = undefined;
        this.artifactResolve?.();
      });
    }
  }

  private connectionLostError(exit: RemoteExit): FleetError {
    if (this.transport.isConnectionFailure(exit, this.stderrTail)) {
      return new FleetError('transport', `Can't reach ${this.transport.description}.`, firstLines(this.stderrTail, 3));
    }
    return new FleetError('transport', `Connection to ${this.transport.description} ended early (ssh exit ${exit.code ?? exit.signal ?? 'unknown'}).`, firstLines(this.stderrTail, 3));
  }
}

export class TimeoutWaitingError extends Error {
  constructor(words: readonly string[]) {
    super(`Timed out waiting for ${words.join(' or ')}`);
    this.name = 'TimeoutWaitingError';
  }
}
