// Apple's rsync bypasses the OS file cache by default. Repeated checksums of
// freshly staged source should use that existing cache on either volume.
import { spawnSync } from 'node:child_process';

let supportsFileCache: boolean | undefined;

export function rsyncFileCacheArguments(): string[] {
  if (process.platform !== 'darwin') return [];
  if (supportsFileCache === undefined) {
    const help = spawnSync('/usr/bin/rsync', ['--help'], { encoding: 'utf8', timeout: 1000, maxBuffer: 64 * 1024 });
    supportsFileCache = help.status === 0 && /(?:^|\s|\[)--cache(?:\s|\||\])/m.test(help.stdout ?? '');
  }
  return supportsFileCache ? ['--cache'] : [];
}
