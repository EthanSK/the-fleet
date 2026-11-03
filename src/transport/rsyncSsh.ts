// Rsync's local remote-shell adapter. Apple openrsync splits --rsync-path into
// arguments and can alter nested quoting. Use a fixed placeholder there and
// supply the already quoted receiver command directly to this adapter. Quote
// rsync's server arguments once for SSH. Route options come from the existing
// transport, not another saved SSH configuration or a new network protocol.
import { spawn } from 'node:child_process';
import { shellQuote } from './shellQuote.ts';

const route: unknown = JSON.parse(process.env['FLEET_RUNNER_RSYNC_SSH_ARGS'] ?? 'null');
const [, ...remoteArguments] = process.argv.slice(2); // rsync's placeholder host
const receiver = process.env['FLEET_RUNNER_RSYNC_RECEIVER'];
if (!Array.isArray(route) || !route.every((argument: unknown) => typeof argument === 'string') || remoteArguments[0] !== 'fleet-runner-receiver' || !receiver) {
  process.stderr.write('fleet-runner: invalid rsync SSH invocation\n');
  process.exit(64);
}
const child = spawn('ssh', [...route, `${receiver} ${remoteArguments.slice(1).map(shellQuote).join(' ')}`], { stdio: 'inherit' });
child.on('error', () => { process.exitCode = 255; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143); });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => { child.kill(signal); });
