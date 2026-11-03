// Small validation helpers for Fleet Runner's JSON files.
//
// Manifests and the machine registry are trusted local configuration, but they
// are still external input: a typo must fail loudly with the exact field path
// instead of silently running the wrong command. A hand-written reader keeps the
// CLI dependency-free at runtime (like Agent Bridge) while the TypeScript types
// in manifest.ts / machines.ts stay the single owner of each shape.

import { usageError } from '../errors.ts';

export type JsonObject = { readonly [key: string]: unknown };

export class Reader {
  readonly path: string;
  readonly source: string;

  constructor(source: string, path = '') {
    this.source = source;
    this.path = path;
  }

  child(key: string | number): Reader {
    const segment = typeof key === 'number' ? `[${key}]` : this.path === '' ? key : `.${key}`;
    return new Reader(this.source, `${this.path}${segment}`);
  }

  fail(message: string): never {
    const where = this.path === '' ? this.source : `${this.source}: ${this.path}`;
    throw usageError(`${where}: ${message}`);
  }

  object(value: unknown, allowedKeys: readonly string[]): JsonObject {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) this.fail('must be an object');
    const record = value as JsonObject;
    for (const key of Object.keys(record)) {
      if (!allowedKeys.includes(key)) this.child(key).fail(`unknown field (allowed: ${allowedKeys.join(', ')})`);
    }
    return record;
  }

  string(value: unknown, options: { pattern?: RegExp; patternHint?: string; allowEmpty?: boolean } = {}): string {
    if (typeof value !== 'string') this.fail('must be a string');
    if (!options.allowEmpty && value.length === 0) this.fail('must not be empty');
    if (value.includes('\0')) this.fail('must not contain NUL');
    if (options.pattern && !options.pattern.test(value)) this.fail(options.patternHint ?? `must match ${options.pattern}`);
    return value;
  }

  optionalString(value: unknown, options: { pattern?: RegExp; patternHint?: string } = {}): string | undefined {
    return value === undefined ? undefined : this.string(value, options);
  }

  boolean(value: unknown): boolean {
    if (typeof value !== 'boolean') this.fail('must be true or false');
    return value;
  }

  optionalBoolean(value: unknown): boolean | undefined {
    return value === undefined ? undefined : this.boolean(value);
  }

  number(value: unknown, options: { min?: number; max?: number; integer?: boolean } = {}): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) this.fail('must be a number');
    if (options.integer && !Number.isInteger(value)) this.fail('must be a whole number');
    if (options.min !== undefined && value < options.min) this.fail(`must be at least ${options.min}`);
    if (options.max !== undefined && value > options.max) this.fail(`must be at most ${options.max}`);
    return value;
  }

  optionalNumber(value: unknown, options: { min?: number; max?: number; integer?: boolean } = {}): number | undefined {
    return value === undefined ? undefined : this.number(value, options);
  }

  array(value: unknown, options: { minLength?: number } = {}): readonly unknown[] {
    if (!Array.isArray(value)) this.fail('must be an array');
    if (options.minLength !== undefined && value.length < options.minLength) {
      this.fail(options.minLength === 1 ? 'must not be empty' : `must have at least ${options.minLength} items`);
    }
    return value;
  }

  stringArray(value: unknown, options: { minLength?: number; pattern?: RegExp; patternHint?: string } = {}): string[] {
    const items = this.array(value, options.minLength === undefined ? {} : { minLength: options.minLength });
    const itemOptions: { pattern?: RegExp; patternHint?: string } = {};
    if (options.pattern) itemOptions.pattern = options.pattern;
    if (options.patternHint) itemOptions.patternHint = options.patternHint;
    return items.map((item, index) => this.child(index).string(item, itemOptions));
  }

  optionalStringArray(value: unknown, options: { minLength?: number; pattern?: RegExp; patternHint?: string } = {}): string[] | undefined {
    return value === undefined ? undefined : this.stringArray(value, options);
  }

  stringRecord(value: unknown, keyPattern: RegExp, keyHint: string): Record<string, string> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) this.fail('must be an object');
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(value as JsonObject)) {
      if (!keyPattern.test(key)) this.child(key).fail(keyHint);
      result[key] = this.child(key).string(item, { allowEmpty: true });
    }
    return result;
  }
}

/** Parses JSON text, reporting the file name on syntax errors. */
export function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw usageError(`${source}: not valid JSON (${reason})`);
  }
}

/** Identifiers used for projects, profiles, machines and caches. Safe in paths and remote job ids. */
export const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const IDENTIFIER_HINT = 'use 1–48 lowercase letters, digits or hyphens, starting with a letter or digit';

/** Environment variable names. */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
