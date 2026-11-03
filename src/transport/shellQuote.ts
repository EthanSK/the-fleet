// POSIX shell quoting for commands sent over ssh.
//
// ssh joins its remote-command arguments with spaces and hands one string to
// the remote user's login shell (zsh on macOS). Fleet Runner therefore passes
// ssh exactly ONE pre-quoted string and builds it here, with every value as a
// single-quoted word. Single quotes are literal in sh, bash and zsh: nothing
// inside them is expanded, so spaces, $, backticks, ;, newlines and a leading
// "-" in a value cannot become shell syntax. The only deliberate expansion is
// remotePathWord's "$HOME" for a "~/" root, which is a fixed literal, never
// user text.

export function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('Shell arguments cannot contain NUL bytes.');
  // Bare words only when unambiguous in sh, bash and zsh. The first character
  // is restricted: zsh expands a leading "=" (EQUALS) and "~"; "-" looks like an option.
  if (/^[A-Za-z0-9_./][A-Za-z0-9_@%+=:,./-]*$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function shellJoin(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ');
}

/**
 * A remote path as one shell word. "~/x" becomes "$HOME"'/x' so the remote
 * shell expands its own home directory; anything else is quoted literally.
 */
export function remotePathWord(path: string): string {
  if (path === '~') return '"$HOME"';
  if (path.startsWith('~/')) return `"$HOME"${shellQuote(path.slice(1))}`;
  return shellQuote(path);
}

/**
 * A command that runs an inline bash script with positional arguments:
 *   /bin/bash -c '<script>' <name> <args...>
 * Arguments are already-formed shell words (use shellQuote or remotePathWord).
 */
export function inlineBashCommand(script: string, name: string, argumentWords: readonly string[]): string {
  return ['/bin/bash', '-c', shellQuote(script), shellQuote(name), ...argumentWords].join(' ');
}
