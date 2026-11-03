// Project manifest: a project's source boundary and its named remote profiles.
//
// A manifest is the only place project commands live; the runner has no
// product-specific branches. It is reusable: keep it in the project, or keep a
// shared adapter (see projects/) and register it with --source.
// Commands in a manifest are trusted local code that runs on the fleet machine
// as the paired user; validation catches mistakes, it is not a sandbox.
//
// Decisions preserved here:
// - Every profile needs an explicit timeout; there is no unlimited job.
// - A "test" profile must state how success is recognized (a minimum test
//   count or required output), so a run that executes zero tests can never be
//   reported as passed. The runner does not guess framework output.
// - A profile can be "blocked" with the exact missing setup. That is preferred
//   over a guessed command for workflows that already have an established,
//   more complex Mini procedure (for example Agent Flow's Xcode flow).
// - Remote agent CLIs are refused as commands: this tool runs builds and
//   tests, never another agent session on the fleet machine.

import { basename } from 'node:path';
import { checkRelativePath } from '../snapshot/relativePath.ts';
import { compileGlob } from '../snapshot/glob.ts';
import { ENV_NAME_PATTERN, IDENTIFIER_HINT, IDENTIFIER_PATTERN, Reader } from './validate.ts';

export const MANIFEST_SCHEMA_VERSION = 1;

export type ProfileKind = 'test' | 'build' | 'check';
const PROFILE_KINDS: readonly ProfileKind[] = ['test', 'build', 'check'];

export interface SyncRules {
  /** Root-anchored glob patterns selecting what to send. Required and explicit. */
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  /** Patterns allowed back in despite the built-in default exclusions (never the safety rules). */
  readonly allowDefaultExcluded: readonly string[];
  readonly maxTotalMiB: number;
  readonly maxFileMiB: number;
}

export interface TestCountCriterion {
  /** Regex with one capture group holding a test count; the largest captured value is used. */
  readonly pattern: string;
  readonly min: number;
}

export interface SuccessCriteria {
  /** Regexes that must each appear in stdout or stderr. */
  readonly requireOutput: readonly string[];
  /** Regexes that fail the run when they appear. */
  readonly rejectOutput: readonly string[];
  readonly minTestCount?: TestCountCriterion;
}

export interface CacheRequest {
  /** Shared cache directory name on the machine (one per name, reused across jobs). */
  readonly name: string;
  /** The cache is deleted after a job when it grows beyond this size. */
  readonly maxGiB: number;
  /** Only opt in after checking the cache tools support concurrent writers. */
  readonly concurrent?: boolean;
}

export interface ProfileRequirements {
  readonly tools: readonly string[];
  /** The remote user must own the active GUI console session (VS Code hosts, AppKit windows). */
  readonly guiSession: boolean;
  /** Environment variables that must come from the machine's private registration. */
  readonly machineEnv: readonly string[];
}

export interface Profile {
  /** Maintenance or work which cannot coexist with another job. */
  readonly exclusive?: boolean;
  /** Worker-local conflicts, for example port:4200 or a shared DerivedData path. */
  readonly resources?: readonly string[];
  readonly name: string;
  readonly description: string;
  readonly kind: ProfileKind;
  /** Executed directly (no shell) after the prepare steps, from cwd. */
  readonly argv: readonly string[];
  readonly prepare: readonly (readonly string[])[];
  /** Additional input patterns for this profile, under the same exclusions and limits. */
  readonly extraInputs: readonly string[];
  /** Idempotent cleanup of owned resources outside the process group. Runs before scratch deletion. */
  readonly finalizer?: { readonly argv: readonly string[]; readonly timeoutSeconds: number };
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly pathPrepend: readonly string[];
  readonly requires: ProfileRequirements;
  readonly timeoutMinutes: number;
  readonly artifacts: readonly string[];
  readonly maxArtifactMiB: number;
  readonly success: SuccessCriteria;
  readonly cache?: CacheRequest;
  /** Opt-in reusable source transfer, kept inside the profile's bounded cache. */
  readonly sourceTransfer?: 'tar' | 'rsync';
  /** Extra arguments after "--" on the command line are appended to argv. */
  readonly allowExtraArgs: boolean;
  /** Point TMPDIR inside the job directory so temporary files are cleaned with it. */
  readonly isolatedTmp: boolean;
  /** When set, the profile is documented but cannot run; the text names the missing setup. */
  readonly blocked?: string;
}

export interface LocalOnlyNote {
  readonly command: string;
  readonly reason: string;
}

export interface ProjectManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  readonly id: string;
  readonly description?: string;
  /** Relative to the manifest file, or absolute. Optional: register --source can supply it. */
  readonly sourceRoot?: string;
  readonly defaultMachine?: string;
  readonly sync: SyncRules;
  readonly profiles: Readonly<Record<string, Profile>>;
  /** Commands that must stay on the owning Mac (installers, devices, live apps). Shown, never run. */
  readonly localOnly: readonly LocalOnlyNote[];
}

// Basenames that start agent sessions. `agent-bridge` is included because a
// profile that shells back through the bridge would bypass this runner's lock.
const AGENT_COMMANDS = new Set(['claude', 'codex', 'gemini', 'aider', 'opencode', 'openclaw', 'cursor-agent', 'agent-bridge', 'claude-bridge']);

// Placeholders the remote supervisor substitutes in argv and env values.
export const PLACEHOLDERS = ['@JOB_DIR@', '@SRC_DIR@', '@CACHE_DIR@'] as const;

// Defaults sized for the 16 GiB Mini with ~30 GiB free: bounded transfers and returns.
const DEFAULT_MAX_TOTAL_MIB = 512;
const DEFAULT_MAX_FILE_MIB = 100;
const DEFAULT_MAX_ARTIFACT_MIB = 512;
const MAX_TIMEOUT_MINUTES = 24 * 60;

export function parseManifest(value: unknown, source: string): ProjectManifest {
  const reader = new Reader(source);
  const root = reader.object(value, ['$schema', 'schemaVersion', 'id', 'description', 'sourceRoot', 'defaultMachine', 'sync', 'profiles', 'localOnly']);
  const schemaVersion = reader.child('schemaVersion').number(root['schemaVersion'], { integer: true });
  if (schemaVersion !== MANIFEST_SCHEMA_VERSION) reader.child('schemaVersion').fail(`must be ${MANIFEST_SCHEMA_VERSION}`);
  const id = reader.child('id').string(root['id'], { pattern: IDENTIFIER_PATTERN, patternHint: IDENTIFIER_HINT });
  const description = reader.child('description').optionalString(root['description']);
  const sourceRoot = reader.child('sourceRoot').optionalString(root['sourceRoot']);
  const defaultMachine = reader.child('defaultMachine').optionalString(root['defaultMachine']);
  const sync = parseSync(reader.child('sync'), root['sync']);

  const profilesReader = reader.child('profiles');
  const profilesValue = root['profiles'];
  if (typeof profilesValue !== 'object' || profilesValue === null || Array.isArray(profilesValue)) profilesReader.fail('must be an object of named profiles');
  const profileEntries = Object.entries(profilesValue as Record<string, unknown>);
  if (profileEntries.length === 0) profilesReader.fail('must define at least one profile');
  const profiles: Record<string, Profile> = {};
  for (const [name, profileValue] of profileEntries) {
    const profileReader = profilesReader.child(name);
    if (!IDENTIFIER_PATTERN.test(name)) profileReader.fail(`profile name: ${IDENTIFIER_HINT}`);
    profiles[name] = parseProfile(profileReader, name, profileValue);
  }

  const localOnly = root['localOnly'] === undefined
    ? []
    : reader.child('localOnly').array(root['localOnly']).map((item, index) => {
        const itemReader = reader.child('localOnly').child(index);
        const note = itemReader.object(item, ['command', 'reason']);
        return { command: itemReader.child('command').string(note['command']), reason: itemReader.child('reason').string(note['reason']) };
      });

  const manifest: ProjectManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id,
    sync,
    profiles,
    localOnly,
    ...(description === undefined ? {} : { description }),
    ...(sourceRoot === undefined ? {} : { sourceRoot }),
    ...(defaultMachine === undefined ? {} : { defaultMachine }),
  };
  return manifest;
}

// Extracted from parseSync's patternList so profile inputs use the same validation.
function parsePatterns(reader: Reader, raw: unknown, required = false): string[] {
  if (raw === undefined && !required) return [];
  const patterns = reader.stringArray(raw, required ? { minLength: 1 } : {});
  patterns.forEach((pattern, index) => {
    const compiled = compileGlob(pattern);
    if (!compiled.ok) reader.child(index).fail(compiled.reason);
  });
  return patterns;
}

function parseSync(reader: Reader, value: unknown): SyncRules {
  const sync = reader.object(value, ['include', 'exclude', 'allowDefaultExcluded', 'maxTotalMiB', 'maxFileMiB']);
  return {
    include: parsePatterns(reader.child('include'), sync['include'], true),
    exclude: parsePatterns(reader.child('exclude'), sync['exclude']),
    allowDefaultExcluded: parsePatterns(reader.child('allowDefaultExcluded'), sync['allowDefaultExcluded']),
    maxTotalMiB: reader.child('maxTotalMiB').optionalNumber(sync['maxTotalMiB'], { min: 1, max: 16384 }) ?? DEFAULT_MAX_TOTAL_MIB,
    maxFileMiB: reader.child('maxFileMiB').optionalNumber(sync['maxFileMiB'], { min: 1, max: 4096 }) ?? DEFAULT_MAX_FILE_MIB,
  };
}

function parseArgv(reader: Reader, value: unknown): string[] {
  const argv = reader.stringArray(value, { minLength: 1 });
  const command = argv[0] ?? '';
  if (AGENT_COMMANDS.has(basename(command).toLowerCase())) {
    reader.child(0).fail(`"${command}" starts an agent session; profiles run builds and tests only`);
  }
  return argv;
}

function parseProfile(reader: Reader, name: string, value: unknown): Profile {
  const profile = reader.object(value, [
    'description', 'kind', 'argv', 'prepare', 'cwd', 'env', 'pathPrepend', 'requires', 'timeoutMinutes', 'artifacts',
    'maxArtifactMiB', 'success', 'cache', 'sourceTransfer', 'allowExtraArgs', 'isolatedTmp', 'blocked', 'extraInputs', 'finalizer', 'exclusive', 'resources',
  ]);
  const description = reader.child('description').string(profile['description']);
  const kindValue = reader.child('kind').string(profile['kind']);
  if (!PROFILE_KINDS.includes(kindValue as ProfileKind)) reader.child('kind').fail(`must be one of: ${PROFILE_KINDS.join(', ')}`);
  const kind = kindValue as ProfileKind;
  const argv = parseArgv(reader.child('argv'), profile['argv']);
  const prepare = profile['prepare'] === undefined
    ? []
    : reader.child('prepare').array(profile['prepare']).map((step, index) => parseArgv(reader.child('prepare').child(index), step));

  const cwdValue = reader.child('cwd').optionalString(profile['cwd']) ?? '.';
  const cwdCheck = checkRelativePath(cwdValue, { allowDot: true });
  const cwd = cwdCheck.ok ? cwdCheck.normalized : reader.child('cwd').fail(cwdCheck.reason);

  const env = profile['env'] === undefined ? {} : reader.child('env').stringRecord(profile['env'], ENV_NAME_PATTERN, 'must be a valid environment variable name');
  for (const key of Object.keys(env)) {
    if (key === 'PATH') reader.child('env').child(key).fail('use pathPrepend instead of replacing PATH');
    if (key.startsWith('FLEET_RUNNER_')) reader.child('env').child(key).fail('FLEET_RUNNER_* variables are set by the runner');
  }
  const pathPrepend = reader.child('pathPrepend').optionalStringArray(profile['pathPrepend'], {
    pattern: /^(\/|~\/)[^:]*$/,
    patternHint: 'must be an absolute or ~/ path without ":"',
  }) ?? [];

  const requires = parseRequirements(reader.child('requires'), profile['requires']);
  // Fractions are allowed (0.05 = 3 s) so quick checks and tests can use short limits.
  const timeoutMinutes = reader.child('timeoutMinutes').number(profile['timeoutMinutes'], { min: 0.05, max: MAX_TIMEOUT_MINUTES });

  const artifacts = (reader.child('artifacts').optionalStringArray(profile['artifacts']) ?? []).map((artifact, index) => {
    const check = checkRelativePath(artifact);
    return check.ok ? check.normalized : reader.child('artifacts').child(index).fail(check.reason);
  });
  const maxArtifactMiB = reader.child('maxArtifactMiB').optionalNumber(profile['maxArtifactMiB'], { min: 1, max: 8192 }) ?? DEFAULT_MAX_ARTIFACT_MIB;

  const success = parseSuccess(reader.child('success'), profile['success']);
  const blocked = reader.child('blocked').optionalString(profile['blocked']);
  if (kind === 'test' && blocked === undefined && success.minTestCount === undefined && success.requireOutput.length === 0) {
    reader.child('success').fail('a test profile needs success.minTestCount or success.requireOutput, so zero tests can never pass');
  }

  let cache: CacheRequest | undefined;
  if (profile['cache'] !== undefined) {
    const cacheReader = reader.child('cache');
    const cacheValue = cacheReader.object(profile['cache'], ['name', 'maxGiB', 'concurrent']);
    cache = {
      name: cacheReader.child('name').string(cacheValue['name'], { pattern: IDENTIFIER_PATTERN, patternHint: IDENTIFIER_HINT }),
      maxGiB: cacheReader.child('maxGiB').number(cacheValue['maxGiB'], { min: 0.1, max: 64 }),
      concurrent: cacheReader.child('concurrent').optionalBoolean(cacheValue['concurrent']) ?? false,
    };
  }

  const allowExtraArgs = reader.child('allowExtraArgs').optionalBoolean(profile['allowExtraArgs']) ?? false;
  const sourceTransfer = reader.child('sourceTransfer').optionalString(profile['sourceTransfer']);
  if (sourceTransfer !== undefined && sourceTransfer !== 'tar' && sourceTransfer !== 'rsync') {
    reader.child('sourceTransfer').fail('must be "tar" or "rsync"');
  }
  if (sourceTransfer === 'rsync' && cache === undefined) {
    reader.child('sourceTransfer').fail('rsync needs a named cache with a size limit');
  }
  const isolatedTmp = reader.child('isolatedTmp').optionalBoolean(profile['isolatedTmp']) ?? false;
  const resources = reader.child('resources').optionalStringArray(profile['resources'], { pattern: /^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,199}$/, patternHint: 'use a short named worker resource' }) ?? [];
  if (resources.length > (requires.guiSession ? 31 : 32)) reader.child('resources').fail('at most 32 resources including desktop');
  let finalizer: Profile['finalizer'];
  if (profile['finalizer'] !== undefined) {
    const child = reader.child('finalizer');
    const raw = child.object(profile['finalizer'], ['argv', 'timeoutSeconds']);
    finalizer = { argv: parseArgv(child.child('argv'), raw['argv']), timeoutSeconds: child.child('timeoutSeconds').number(raw['timeoutSeconds'], { integer: true, min: 1, max: 60 }) };
  }

  return {
    name,
    exclusive: reader.child('exclusive').optionalBoolean(profile['exclusive']) ?? false,
    resources,
    description,
    kind,
    argv,
    prepare,
    extraInputs: parsePatterns(reader.child('extraInputs'), profile['extraInputs']),
    cwd,
    env,
    pathPrepend,
    requires,
    timeoutMinutes,
    artifacts,
    maxArtifactMiB,
    success,
    allowExtraArgs,
    isolatedTmp,
    ...(finalizer === undefined ? {} : { finalizer }),
    ...(cache === undefined ? {} : { cache }),
    ...(sourceTransfer === undefined ? {} : { sourceTransfer: sourceTransfer as 'tar' | 'rsync' }),
    ...(blocked === undefined ? {} : { blocked }),
  };
}

function parseRequirements(reader: Reader, value: unknown): ProfileRequirements {
  if (value === undefined) return { tools: [], guiSession: false, machineEnv: [] };
  const requires = reader.object(value, ['tools', 'guiSession', 'machineEnv']);
  return {
    tools: reader.child('tools').optionalStringArray(requires['tools'], {
      pattern: /^[A-Za-z0-9._+-]+$/,
      patternHint: 'must be a command name such as "swift" (no paths or spaces)',
    }) ?? [],
    guiSession: reader.child('guiSession').optionalBoolean(requires['guiSession']) ?? false,
    machineEnv: reader.child('machineEnv').optionalStringArray(requires['machineEnv'], {
      pattern: ENV_NAME_PATTERN,
      patternHint: 'must be a valid environment variable name',
    }) ?? [],
  };
}

function parseSuccess(reader: Reader, value: unknown): SuccessCriteria {
  if (value === undefined) return { requireOutput: [], rejectOutput: [] };
  const success = reader.object(value, ['requireOutput', 'rejectOutput', 'minTestCount']);
  const regexList = (key: string): string[] => {
    const list = reader.child(key).optionalStringArray(success[key]) ?? [];
    list.forEach((pattern, index) => compileRegex(reader.child(key).child(index), pattern));
    return list;
  };
  const requireOutput = regexList('requireOutput');
  const rejectOutput = regexList('rejectOutput');
  let minTestCount: TestCountCriterion | undefined;
  if (success['minTestCount'] !== undefined) {
    const countReader = reader.child('minTestCount');
    const count = countReader.object(success['minTestCount'], ['pattern', 'min']);
    const pattern = countReader.child('pattern').string(count['pattern']);
    const regex = compileRegex(countReader.child('pattern'), pattern);
    // A capture group is required: the count comes from group 1.
    if (new RegExp(`${regex.source}|`).exec('')?.length === 1) countReader.child('pattern').fail('needs a capture group around the test count, like "Executed (\\\\d+) tests"');
    minTestCount = { pattern, min: countReader.child('min').number(count['min'], { min: 1, integer: true }) };
  }
  return { requireOutput, rejectOutput, ...(minTestCount === undefined ? {} : { minTestCount }) };
}

function compileRegex(reader: Reader, pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'm');
  } catch (error) {
    return reader.fail(`not a valid regular expression (${error instanceof Error ? error.message : String(error)})`);
  }
}
