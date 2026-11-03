// Minimal, explicit glob matching for sync include/exclude patterns.
//
// Semantics (deliberately simple and documented in the README):
// - Patterns are anchored at the source root and use "/" separators.
//   "*.swift" matches only top-level files; use "**/*.swift" for any depth.
// - "*" matches within one path segment, "?" one character, "**" as a whole
//   segment matches zero or more segments, "{a,b}" picks one alternative.
// - A pattern that names a directory also covers everything inside it, so
//   "Sources" and "Sources/**" select the same files.
// - "*" matches dotfiles too. Credentials are blocked by the separate safety
//   rules in rules.ts, not by glob quirks.
// Character classes ("[...]") are rejected so a literal bracket in a name is
// never silently treated as a class.

import { checkRelativePath } from './relativePath.ts';

type Segment = { readonly kind: 'globstar' } | { readonly kind: 'segment'; readonly regex: RegExp };

export interface CompiledGlob {
  readonly pattern: string;
  readonly regex: RegExp;
  readonly segments: readonly Segment[];
}

export type GlobCheck = { ok: true; glob: CompiledGlob } | { ok: false; reason: string };

export function compileGlob(pattern: string): GlobCheck {
  if (/[[\]]/.test(pattern)) return { ok: false, reason: 'character classes ("[...]") are not supported' };
  const checked = checkRelativePath(pattern, { allowGlob: true });
  if (!checked.ok) return checked;
  const rawSegments = checked.normalized.split('/');
  if (rawSegments.some((segment) => segment.includes('**') && segment !== '**')) {
    return { ok: false, reason: '"**" must be a whole path segment, like "Sources/**/*.swift"' };
  }
  let source = '';
  let previousWasGlobstar = false;
  const segments: Segment[] = [];
  rawSegments.forEach((segment, index) => {
    const isLast = index === rawSegments.length - 1;
    if (segment === '**') {
      segments.push({ kind: 'globstar' });
      if (isLast) {
        source += index === 0 ? '.*' : '/.*';
      } else {
        source += index === 0 ? '(?:[^/]+/)*' : '/(?:[^/]+/)*';
      }
      previousWasGlobstar = !isLast;
      return;
    }
    const segmentSource = segmentToRegex(segment);
    segments.push({ kind: 'segment', regex: new RegExp(`^${segmentSource}$`) });
    source += (index === 0 || previousWasGlobstar ? '' : '/') + segmentSource;
    previousWasGlobstar = false;
  });
  return { ok: true, glob: { pattern, regex: new RegExp(`^${source}$`), segments } };
}

function segmentToRegex(segment: string): string {
  let result = '';
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index] ?? '';
    if (character === '*') {
      result += '[^/]*';
    } else if (character === '?') {
      result += '[^/]';
    } else if (character === '{') {
      const close = segment.indexOf('}', index);
      if (close === -1) {
        result += '\\{';
        continue;
      }
      const alternatives = segment.slice(index + 1, close).split(',');
      result += `(?:${alternatives.map(segmentToRegex).join('|')})`;
      index = close;
    } else {
      result += character.replace(/[.+^$()|\\}]/g, '\\$&');
    }
  }
  return result;
}

/** True when the glob matches `path` itself or any ancestor directory of it. */
export function matchesPathOrAncestor(globs: readonly CompiledGlob[], path: string): CompiledGlob | undefined {
  const segments = path.split('/');
  for (let length = 1; length <= segments.length; length += 1) {
    const candidate = segments.slice(0, length).join('/');
    const match = globs.find((glob) => glob.regex.test(candidate));
    if (match) return match;
  }
  return undefined;
}

/**
 * True when the glob could match the directory itself or something inside it.
 * Used to skip directories no include pattern can reach, and to keep a
 * default-excluded directory walkable when an allow pattern reaches inside it.
 */
export function couldMatchWithin(glob: CompiledGlob, directoryPath: string): boolean {
  const directorySegments = directoryPath.split('/');
  const visit = (patternIndex: number, directoryIndex: number): boolean => {
    if (directoryIndex === directorySegments.length) return true; // Directory consumed; pattern may continue inside it.
    if (patternIndex === glob.segments.length) return true; // Pattern names an ancestor, which covers its subtree.
    const segment = glob.segments[patternIndex];
    if (!segment) return false;
    if (segment.kind === 'globstar') {
      // "**" can absorb any number of directory segments, including none.
      return visit(patternIndex + 1, directoryIndex) || visit(patternIndex, directoryIndex + 1);
    }
    return segment.regex.test(directorySegments[directoryIndex] ?? '') && visit(patternIndex + 1, directoryIndex + 1);
  };
  return visit(0, 0);
}

/** True when an exclude glob covers a whole directory (the directory itself or "dir/**"). */
export function coversDirectory(glob: CompiledGlob, directoryPath: string): boolean {
  return glob.regex.test(directoryPath) || glob.regex.test(`${directoryPath}/`);
}
