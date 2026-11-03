// Minimal argument parser for the fleet-runner CLI (no dependencies).
//
// Supports positionals, "--flag", "--name value", repeated "--name value" for
// list options, and "--" to pass the rest through to a profile command. Unknown
// options are errors, so a typo never silently changes what runs.

import { usageError } from '../errors.ts';

export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly passthrough: readonly string[];
}

export interface OptionSpec {
  readonly flags?: readonly string[];
  readonly values?: readonly string[];
}

/** Help must return before service startup, reservation or payload reads. */
export function isHelpRequest(argv: readonly string[]): boolean {
  if (argv.length === 0 || argv[0] === 'help') return true;
  for (const argument of argv) {
    // After --, help belongs to the profile command rather than The Fleet.
    if (argument === '--') return false;
    if (argument === '--help' || argument === '-h') return true;
  }
  return false;
}

export function parseArgs(argv: readonly string[], spec: OptionSpec): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  let passthrough: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument === '--') {
      passthrough = argv.slice(index + 1);
      break;
    }
    if (argument.startsWith('--')) {
      const equals = argument.indexOf('=');
      const name = equals === -1 ? argument.slice(2) : argument.slice(2, equals);
      if (spec.flags?.includes(name)) {
        if (equals !== -1) throw usageError(`--${name} doesn't take a value.`);
        flags.add(name);
        continue;
      }
      if (spec.values?.includes(name)) {
        const value = equals === -1 ? argv[index + 1] : argument.slice(equals + 1);
        if (value === undefined || (equals === -1 && value.startsWith('--'))) throw usageError(`--${name} needs a value.`);
        if (equals === -1) index += 1;
        values.set(name, [...(values.get(name) ?? []), value]);
        continue;
      }
      throw usageError(`Unknown option --${name}. See: fleet-runner help`);
    }
    if (argument.startsWith('-') && argument !== '-') throw usageError(`Unknown option ${argument}. See: fleet-runner help`);
    positionals.push(argument);
  }
  return { positionals, flags, values, passthrough };
}

export function single(args: ParsedArgs, name: string): string | undefined {
  const list = args.values.get(name);
  if (list && list.length > 1) throw usageError(`--${name} can only be given once.`);
  return list?.[0];
}

export function expectPositionals(args: ParsedArgs, names: readonly string[], usage: string): string[] {
  if (args.positionals.length !== names.length) throw usageError(`Usage: ${usage}`);
  return [...args.positionals];
}
