// ssh transport over an Agent Bridge target's existing route.
//
// The option set mirrors `agent-bridge run` so connections behave exactly like
// the configured pairing route (Tailscale endpoint when configured, the paired
// identity file). Host identities are remembered and changed keys are refused. Additions, each for a
// reason:
// - BatchMode=yes: never block on a password or passphrase prompt.
// - -T: no TTY, so stdout and stderr stay separate and binary-safe.
// - -C: stream compression for source/fixture transfers. The full Wand fixture
//   set is over a GiB; uncompressed transfer dominated its Mini run time.
// - ServerAliveInterval/CountMax: a vanished machine is noticed in about a
//   minute instead of hanging the CLI.
// The command is passed as one argument; ssh sends it verbatim to the remote
// login shell, and this Mac never runs a shell for it.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Machine } from '../schema/machines.ts';
import { loadAgentBridgeRoute, type AgentBridgeRoute } from './agentBridgeConfig.ts';
import { wrapChild, type RemoteExit, type RemoteProcess, type Transport } from './transport.ts';
import { shellQuote } from './shellQuote.ts';

// Client-side connection failure phrases, matching agent-bridge's
// _ssh_is_connection_failure. Exit 255 alone is ambiguous: the remote command
// can return 255 too.
const CONNECTION_FAILURE_PHRASES = [
  'ssh: connect to host',
  'ssh: Could not resolve hostname',
  'ssh_exchange_identification:',
  'kex_exchange_identification:',
  'Host key verification failed',
  'Permission denied (publickey',
  'No route to host',
  'Network is unreachable',
  'Name or service not known',
  'Connection timed out',
  'Operation timed out',
];

export function sshArguments(route: AgentBridgeRoute): string[] {
  const args = [
    '-C',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    '-o', 'LogLevel=ERROR',
    '-o', 'BatchMode=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
    '-T',
    '-p', String(route.port),
  ];
  if (route.identityFile !== undefined) args.push('-i', route.identityFile, '-o', 'IdentitiesOnly=yes');
  args.push(`${route.user}@${route.host}`);
  return args;
}

export class SshTransport implements Transport {
  readonly description: string;
  readonly route: AgentBridgeRoute;

  constructor(route: AgentBridgeRoute) {
    this.route = route;
    this.description = `Agent Bridge target ${route.target} (${route.path} route)`;
  }

  static forMachine(machine: Machine): SshTransport {
    return new SshTransport(loadAgentBridgeRoute(machine.transport.target, machine.transport.configPath));
  }

  start(remoteCommand: string): RemoteProcess {
    const child = spawn('ssh', [...sshArguments(this.route), remoteCommand], { stdio: ['pipe', 'pipe', 'pipe'] });
    return wrapChild(child);
  }

  startRsync(sourceDirectory: string, receiverCommand: string): RemoteProcess {
    // Same SSH options and identity as start(); no new connection config.
    // Only the private selected-source directory is traversed recursively.
    const rsh = [process.execPath, fileURLToPath(new URL('./rsyncSsh.ts', import.meta.url))].map(shellQuote).join(' ');
    return wrapChild(spawn('/usr/bin/rsync', [
      '-rlptc', '--delete', '--stats', '--no-owner', '--no-group',
      '-e', rsh, '--rsync-path', 'fleet-runner-receiver',
      `${sourceDirectory}/`, 'fleet-worker:fleet-runner-source',
    ], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FLEET_RUNNER_RSYNC_SSH_ARGS: JSON.stringify(sshArguments(this.route)), FLEET_RUNNER_RSYNC_RECEIVER: receiverCommand } }));
  }

  isConnectionFailure(exit: RemoteExit, stderr: string): boolean {
    return exit.code === 255 && CONNECTION_FAILURE_PHRASES.some((phrase) => stderr.includes(phrase));
  }
}
