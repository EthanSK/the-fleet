// Controlled rsync transport for lifecycle tests. Only SSH is substituted by
// a local shell; the real rsync protocol and production receiver run intact.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shellQuote } from '../../src/transport/shellQuote.ts';
import { startGatedRsync, type RemoteProcess } from '../../src/transport/transport.ts';
import { LocalShellTransport } from './localShellTransport.ts';
import { rsyncFileCacheArguments } from '../../src/transport/rsyncArguments.ts';

export class RsyncTransport extends LocalShellTransport {
  readonly home: string;
  readonly extraArguments: string[] = [];
  beforeSync: (() => void) | undefined;
  sourceDirectory: string | undefined;
  readonly sourceDirectories: string[] = [];
  transformReceiver: ((command: string) => string) | undefined;

  constructor(home: string) {
    super(home);
    this.home = home;
    writeFileSync(join(home, 'rsync-shell'), '#!/bin/bash\nshift\n[ "$1" = fleet-runner-receiver ] || exit 64\nshift\ncommand="$FLEET_RUNNER_RSYNC_RECEIVER"\nfor argument; do printf -v word "%q" "$argument"; command="$command $word"; done\nexec /bin/bash -c "$command"\n', { mode: 0o700 });
  }

  startRsync(sourceDirectory: string, receiverCommand: string): RemoteProcess {
    this.sourceDirectory = sourceDirectory;
    this.sourceDirectories.push(sourceDirectory);
    this.beforeSync?.();
    const command = this.transformReceiver?.(receiverCommand) ?? receiverCommand;
    return startGatedRsync([
      '-rlptc', '--delete', '--stats', '--no-owner', '--no-group', ...rsyncFileCacheArguments(), ...this.extraArguments,
      '-e', shellQuote(join(this.home, 'rsync-shell')), '--rsync-path', 'fleet-runner-receiver',
      `${sourceDirectory}/`, 'fixture:fleet-runner-source',
    ], { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: this.home, LANG: 'en_US.UTF-8', FLEET_RUNNER_RSYNC_RECEIVER: command });
  }
}
