// Parses the supervisor's stdout stream (protocol described in supervisor.sh).
//
// The same ssh stdout carries three kinds of data in sequence: protocol lines,
// then the job's raw stdout, then protocol lines and an optional binary
// artifact archive. Job output is forwarded byte-for-byte: the end marker
// "\n@@FR-<nonce>@@END\n" includes its leading newline, so stripping it never
// adds or removes a byte of real output, and a trailing partial marker is held
// back only until the next chunk decides it.

export type SupervisorEvent =
  | { readonly type: 'protocol'; readonly word: string; readonly rest: string }
  | { readonly type: 'job-stdout'; readonly data: Buffer }
  | { readonly type: 'job-end' }
  | { readonly type: 'artifact-data'; readonly data: Buffer }
  | { readonly type: 'artifact-end' }
  | { readonly type: 'noise'; readonly line: string };

type State = { readonly kind: 'lines' } | { readonly kind: 'job' } | { kind: 'binary'; remaining: number };

const PROTOCOL_PREFIX = '@@FR ';

export class SupervisorStreamParser {
  private state: State = { kind: 'lines' };
  private buffer: Buffer = Buffer.alloc(0);
  private readonly marker: Buffer;
  private readonly onEvent: (event: SupervisorEvent) => void;

  constructor(nonce: string, onEvent: (event: SupervisorEvent) => void) {
    this.marker = Buffer.from(`\n@@FR-${nonce}@@END\n`, 'utf8');
    this.onEvent = onEvent;
  }

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    // Each pass consumes as much as the current state allows; a state change
    // continues with the remaining bytes in the same call.
    for (;;) {
      if (this.state.kind === 'lines') {
        const newline = this.buffer.indexOf(0x0a);
        if (newline === -1) return;
        const line = this.buffer.subarray(0, newline).toString('utf8');
        this.buffer = this.buffer.subarray(newline + 1);
        this.handleLine(line);
        continue;
      }
      if (this.state.kind === 'job') {
        const index = this.buffer.indexOf(this.marker);
        if (index !== -1) {
          if (index > 0) this.onEvent({ type: 'job-stdout', data: this.buffer.subarray(0, index) });
          this.buffer = this.buffer.subarray(index + this.marker.length);
          this.state = { kind: 'lines' };
          this.onEvent({ type: 'job-end' });
          continue;
        }
        const safeLength = Math.max(0, this.buffer.length - (this.marker.length - 1));
        // Hold back only a suffix that could still be the start of the marker.
        let holdFrom = safeLength;
        while (holdFrom < this.buffer.length && !this.marker.subarray(0, this.buffer.length - holdFrom).equals(this.buffer.subarray(holdFrom))) {
          holdFrom += 1;
        }
        if (holdFrom > 0) {
          this.onEvent({ type: 'job-stdout', data: this.buffer.subarray(0, holdFrom) });
          this.buffer = this.buffer.subarray(holdFrom);
        }
        return;
      }
      // Binary artifact archive of a known length.
      if (this.buffer.length === 0) return;
      const take = Math.min(this.state.remaining, this.buffer.length);
      this.onEvent({ type: 'artifact-data', data: this.buffer.subarray(0, take) });
      this.buffer = this.buffer.subarray(take);
      this.state.remaining -= take;
      if (this.state.remaining === 0) {
        this.state = { kind: 'lines' };
        this.onEvent({ type: 'artifact-end' });
      }
    }
  }

  /** Flushes held-back job output when the stream ends without a marker (connection lost). */
  end(): void {
    if (this.state.kind === 'job' && this.buffer.length > 0) {
      this.onEvent({ type: 'job-stdout', data: this.buffer });
    } else if (this.state.kind === 'lines' && this.buffer.length > 0) {
      this.handleLine(this.buffer.toString('utf8'));
    }
    this.buffer = Buffer.alloc(0);
  }

  get inJob(): boolean {
    return this.state.kind === 'job';
  }

  private handleLine(line: string): void {
    if (!line.startsWith(PROTOCOL_PREFIX)) {
      if (line.trim() !== '') this.onEvent({ type: 'noise', line });
      return;
    }
    const body = line.slice(PROTOCOL_PREFIX.length);
    const space = body.indexOf(' ');
    const word = space === -1 ? body : body.slice(0, space);
    const rest = space === -1 ? '' : body.slice(space + 1);
    this.onEvent({ type: 'protocol', word, rest });
    if (word === 'STARTED') {
      this.state = { kind: 'job' };
    } else if (word === 'ARTIFACTS') {
      const length = Number.parseInt(rest, 10);
      if (Number.isSafeInteger(length) && length > 0) {
        this.state = { kind: 'binary', remaining: length };
      } else {
        this.onEvent({ type: 'artifact-end' });
      }
    }
  }
}

/** Parses "key=value key=value" protocol fields (values contain no spaces). */
export function parseFields(rest: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const token of rest.split(' ')) {
    const equals = token.indexOf('=');
    if (equals > 0) fields.set(token.slice(0, equals), token.slice(equals + 1));
  }
  return fields;
}
