// Structured API refusals with an HTTP status and a stable machine-readable
// code. FleetError keeps owning CLI exit codes; these cover HTTP-only cases.

export type ApiErrorCode = 'revision-conflict' | 'not-found' | 'invalid' | 'busy' | 'unknown-route';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly extra: Readonly<Record<string, unknown>>;

  constructor(status: number, code: ApiErrorCode, message: string, extra: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function notFound(message: string): ApiError {
  return new ApiError(404, 'not-found', message);
}
