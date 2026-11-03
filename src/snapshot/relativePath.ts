// Validation for project-relative paths and glob patterns.
//
// Every path that crosses to the remote machine (sync patterns, profile cwd,
// artifact paths) must stay inside the job's own directory. Rejecting absolute
// paths, ".." segments, empty segments, backslashes and a leading "-" here
// prevents path traversal and option injection before any shell or tar sees
// the value. Artifact and cwd paths are later quoted as single shell words too;
// this check is the first boundary, not the only one.

export type RelativePathCheck = { ok: true; normalized: string } | { ok: false; reason: string };

// Control characters would corrupt line-based protocol output and logs.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function checkRelativePath(value: string, options: { allowDot?: boolean; allowGlob?: boolean } = {}): RelativePathCheck {
  if (value.length === 0) return { ok: false, reason: 'must not be empty' };
  if (CONTROL_CHARACTERS.test(value)) return { ok: false, reason: 'must not contain control characters' };
  if (value.includes('\\')) return { ok: false, reason: 'must use "/" separators, not "\\"' };
  if (value.startsWith('/') || value.startsWith('~')) return { ok: false, reason: 'must be relative to the source root' };
  if (value.startsWith('-')) return { ok: false, reason: 'must not start with "-"' };
  if (options.allowDot && (value === '.' || value === './')) return { ok: true, normalized: '.' };
  const trimmed = value.startsWith('./') ? value.slice(2) : value;
  const withoutTrailingSlash = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
  const segments = withoutTrailingSlash.split('/');
  for (const segment of segments) {
    if (segment === '') return { ok: false, reason: 'must not contain empty path segments' };
    if (segment === '.' || segment === '..') return { ok: false, reason: 'must not contain "." or ".." segments' };
    if (!options.allowGlob && /[*?[\]{}]/.test(segment)) return { ok: false, reason: 'must be a plain path, not a pattern' };
  }
  return { ok: true, normalized: withoutTrailingSlash };
}

/** True when `path` equals `ancestor` or lies inside it (both normalized, "/"-separated, "." = root). */
export function isWithin(path: string, ancestor: string): boolean {
  if (ancestor === '.' || ancestor === '') return true;
  return path === ancestor || path.startsWith(`${ancestor}/`);
}
