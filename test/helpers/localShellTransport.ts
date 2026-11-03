// Test transport: runs the exact remote command string with /bin/sh on this
// Mac, with HOME pointed at a temporary "remote home". The real remote scripts
// (lock, supervisor, upload, cleanup) therefore run unchanged; only ssh is
// replaced. This is a test double for automated checks, not a substitute for
// a live run on the fleet machine.

import { spawn } from 'node:child_process';
import { wrapChild, type RemoteExit, type RemoteProcess, type Transport } from '../../src/transport/transport.ts';

export class LocalShellTransport implements Transport {
  readonly description = 'local test shell';
  readonly started: RemoteProcess[] = [];
  readonly commands: string[] = [];
  private readonly remoteHome: string;

  constructor(remoteHome: string) {
    this.remoteHome = remoteHome;
  }

  start(remoteCommand: string): RemoteProcess {
    this.commands.push(remoteCommand);
    const child = spawn('/bin/sh', ['-c', remoteCommand], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: this.remoteHome, LANG: 'en_US.UTF-8' },
    });
    const process = wrapChild(child);
    this.started.push(process);
    return process;
  }

  isConnectionFailure(_exit: RemoteExit, _stderr: string): boolean {
    return false;
  }
}
