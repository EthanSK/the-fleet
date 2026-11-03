// Built-in snapshot exclusion rules.
//
// Two tiers, checked on every path segment:
// - SAFETY rules are never sent, even when a project's include pattern names
//   them: credentials, private keys, VCS internals (.git is never mirrored),
//   browser credential stores and other private runtime state. There is no
//   override; a project that genuinely needs such a file must provision it on
//   the remote machine separately and deliberately.
// - DEFAULT rules skip bulky or machine-local output (dependencies, caches,
//   build products, live databases, logs). A project may opt specific paths
//   back in with sync.allowDefaultExcluded, for example a small committed
//   node_modules tree.
// Matching is by segment name so a rule applies at any depth.

export type ExclusionTier = 'safety' | 'default';

export interface ExclusionMatch {
  readonly tier: ExclusionTier;
  readonly rule: string;
}

interface NameRule {
  readonly rule: string;
  readonly test: (name: string) => boolean;
}

function exact(name: string): NameRule {
  return { rule: name, test: (candidate) => candidate === name };
}

function suffix(ending: string): NameRule {
  return { rule: `*${ending}`, test: (candidate) => candidate.endsWith(ending) };
}

function prefix(start: string): NameRule {
  return { rule: `${start}*`, test: (candidate) => candidate.startsWith(start) };
}

// Template files such as ".env.example" are documentation, not secrets.
const ENV_TEMPLATE_SUFFIXES = ['.example', '.sample', '.template', '.defaults'];

const SAFETY_DIRECTORY_NAMES: readonly NameRule[] = [
  '.git', '.hg', '.svn', '.ssh', '.gnupg', '.aws', '.azure', '.gcloud', '.kube', '.docker',
  '.agent-bridge', '.fleet-runner', '.the-fleet', 'Keychains', '.Trash',
].map(exact);

const SAFETY_FILE_NAMES: readonly NameRule[] = [
  exact('.git'), // worktree pointer files
  {
    rule: '.env / .env.*',
    test: (name) => (name === '.env' || name.startsWith('.env.')) && !ENV_TEMPLATE_SUFFIXES.some((ending) => name.endsWith(ending)),
  },
  ...['.pem', '.key', '.p12', '.pfx', '.p8', '.keychain', '.keychain-db', '.jks', '.keystore'].map(suffix),
  ...['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'].map(prefix),
  ...['.netrc', '.npmrc', '.pypirc', '.git-credentials', 'credentials.json', 'service-account.json'].map(exact),
  // Browser profile stores that hold cookies, saved logins or session keys.
  ...['Cookies', 'Cookies-journal', 'Login Data', 'Login Data-journal', 'Web Data', 'Local State', 'key4.db', 'logins.json', 'cookies.sqlite'].map(exact),
];

const DEFAULT_DIRECTORY_NAMES: readonly NameRule[] = [
  ...[
    'node_modules', '.build', 'DerivedData', '.swiftpm', 'xcuserdata', '.vscode-test', '.next', '.nuxt', '.turbo',
    '.cache', '.parcel-cache', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.venv', 'venv',
    'coverage', '.nyc_output', '.gradle', 'build', 'dist', 'out', 'target', '.outstanding-items',
  ].map(exact),
  suffix('.noindex'),
];

const DEFAULT_FILE_NAMES: readonly NameRule[] = [
  exact('.DS_Store'),
  ...['.sqlite', '.sqlite3', '.db', '-wal', '-shm', '-journal', '.ldb', '.log', '.vsix', '.dmg', '.xcarchive'].map(suffix),
];

/**
 * Checks one path (relative, "/"-separated) against both tiers.
 * Directory segments are checked against directory rules; the final segment
 * of a file path against file rules too.
 */
export function matchExclusionRules(relativePath: string, kind: 'file' | 'directory' | 'symlink'): ExclusionMatch | undefined {
  const segments = relativePath.split('/');
  const last = segments.length - 1;
  let defaultMatch: ExclusionMatch | undefined;
  for (let index = 0; index < segments.length; index += 1) {
    const name = segments[index] ?? '';
    const isDirectorySegment = index < last || kind === 'directory';
    const safetyRules = isDirectorySegment ? SAFETY_DIRECTORY_NAMES : SAFETY_FILE_NAMES;
    const safety = safetyRules.find((rule) => rule.test(name)) ?? (isDirectorySegment ? undefined : SAFETY_DIRECTORY_NAMES.find((rule) => rule.test(name)));
    if (safety) return { tier: 'safety', rule: safety.rule };
    if (!defaultMatch) {
      const defaultRules = isDirectorySegment ? DEFAULT_DIRECTORY_NAMES : DEFAULT_FILE_NAMES;
      const match = defaultRules.find((rule) => rule.test(name));
      if (match) defaultMatch = { tier: 'default', rule: match.rule };
    }
  }
  return defaultMatch;
}

/** Human-readable list of the safety rules, for README/doctor output. */
export function describeSafetyRules(): string[] {
  return [...SAFETY_DIRECTORY_NAMES.map((rule) => `${rule.rule}/`), ...SAFETY_FILE_NAMES.map((rule) => rule.rule)];
}

export function describeDefaultRules(): string[] {
  return [...DEFAULT_DIRECTORY_NAMES.map((rule) => `${rule.rule}/`), ...DEFAULT_FILE_NAMES.map((rule) => rule.rule)];
}
