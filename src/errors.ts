// Fleet Runner's error type and CLI exit codes.
//
// Every expected failure is a FleetError carrying one closed exit-code kind, so
// the CLI can print one concise line and scripts/agents can branch on the code
// without parsing text. The remote job's exact exit status is never squeezed
// into these codes; it is recorded in the receipt and printed beside the result.

export const EXIT_CODES = {
  ok: 0,
  jobFailed: 1,
  usage: 2,
  machineCheckRefused: 3,
  machineBusy: 4,
  transport: 5,
  timedOut: 6,
  cancelled: 7,
  artifactVerification: 8,
} as const;

export type ExitKind = keyof typeof EXIT_CODES;

export class FleetError extends Error {
  readonly kind: ExitKind;
  /** Optional extra lines (for example individual refusal reasons). */
  readonly details: readonly string[];

  constructor(kind: ExitKind, message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'FleetError';
    this.kind = kind;
    this.details = details;
  }

  get exitCode(): number {
    return EXIT_CODES[this.kind];
  }
}

/** Proof that no supervisor session was attempted; safe to release only this run's lease. */
export class RunNotStartedError extends FleetError {
  constructor(error: unknown) {
    super(error instanceof FleetError ? error.kind : 'transport',
      error instanceof Error ? error.message : String(error),
      error instanceof FleetError ? error.details : []);
    this.name = 'RunNotStartedError';
    this.cause = error;
  }
}

export function usageError(message: string, details: readonly string[] = []): FleetError {
  return new FleetError('usage', message, details);
}
