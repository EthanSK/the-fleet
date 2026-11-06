// fleet-runner CLI dispatcher. Entry point: bin/fleet-runner.js.
//
// Maps commands to handlers, prints help, and turns FleetError into one
// concise message plus the documented exit code. Unexpected errors print a
// stack trace because they are bugs, not user mistakes.

import { FleetError } from '../errors.ts';
import { isHelpRequest } from './args.ts';
import { readFileSync } from 'node:fs';
import { resolveStatePaths } from '../paths.ts';
import { Interrupts } from '../run/runJob.ts';
import { SshTransport } from '../transport/sshTransport.ts';
import { doctorCommand } from './doctor.ts';
import { machineCommand, machinesCommand } from './machineCommands.ts';
import { listCommand, planCommand, registerCommand, showCommand, unregisterCommand, validateCommand } from './projectCommands.ts';
import { cancelCommand, lockCommand, recoverCommand, resultsCommand, runCommand, statusCommand } from './runCommands.ts';
import type { CliContext } from './context.ts';

export const HELP = `The Fleet — one shared coordinator for your workers

Coordinator
  the-fleet state [--fresh]
  the-fleet submit <request.json | -> [--machine <name> | --machines <name,...>]
  the-fleet submit <request.json | -> --dry-run [--machine <name>]
  the-fleet maintain [--machine <name>]
  the-fleet reserve --owner <app> --label <work> [--machines <name,...>] [--shared | --drain] [--resources <name,...>] [--workload standard|e2e]
  the-fleet renew --id <id> --token <token> [--ttl <seconds>]
  the-fleet release --id <id> --token <token> [--work-stopped]
  the-fleet activate --id <id> --token <token>
  the-fleet recover-reservations
  the-fleet service status | install | stop
  the-fleet migrate-home [--dry-run]
  the-fleet rpc <METHOD> </v1/path> [body.json | -]

Projects
  the-fleet project resolve [--source <dir>] [--manifest <file>]
  the-fleet register <manifest.json> [--source <dir>] [--replace]
  the-fleet unregister <project>
  the-fleet list
  the-fleet show <project>
  the-fleet validate <manifest.json>

Runs
  the-fleet plan <project> <profile> [--source <dir>] [--machine <name>] [--files] [--preflight] [--json] [-- <args>]
  the-fleet run <project> <profile> [--source <dir>] [--machine <name> | --machines <name,...>] [--dry-run] [--ignore-heavy-processes] [-- <args>]
  the-fleet results [<job-id>] [--project <project>] [--limit <n>] [--json]
  the-fleet recover <job-id> [--machine <name>]

Machines
  the-fleet machines
  the-fleet machine add <id> --bridge-target <name> [--alias <name>]... [--remote-root <path>] [--path-prepend <dir>]... [--default] [--replace]
  the-fleet doctor [--machine <name>] [--project <project>]
  the-fleet status [--machine <name>]
  the-fleet cancel [--machine <name>] [--job <job-id>]
  the-fleet lock clear [--machine <name>] [--job <job-id>]

plan, run --dry-run, doctor and status never start a build or test.
--source runs another worktree of a registered project; edits are sent as they are on disk.
--machine pins one worker; --machines tries workers in order, once. Dry-run accepts --machine only.
Arguments after -- are appended to the profile command when the profile allows it.

State: ~/.the-fleet (override with THE_FLEET_HOME). Runs, logs and artifacts: runs.noindex inside it.
FLEET_RUNNER_RUNS_DIRECTORY selects an existing absolute .noindex run store while preserving configuration.
Exit codes: 0 passed · 1 failed · 2 usage or config · 3 machine check refused · 4 machine busy
            5 connection or upload · 6 timed out · 7 cancelled · 8 artifact verification
`;

type Handler = (context: CliContext, argv: readonly string[]) => number | Promise<number>;

const COMMANDS: Readonly<Record<string, Handler>> = {
  register: registerCommand,
  unregister: unregisterCommand,
  list: listCommand,
  show: showCommand,
  validate: validateCommand,
  plan: planCommand,
  run: runCommand,
  results: resultsCommand,
  recover: recoverCommand,
  machines: machinesCommand,
  machine: machineCommand,
  doctor: doctorCommand,
  status: statusCommand,
  cancel: cancelCommand,
  lock: lockCommand,
};

export async function main(argv: readonly string[], context: CliContext): Promise<number> {
  const [command = '', ...rest] = argv;
  if (isHelpRequest(argv)) {
    context.stdout.write(HELP);
    return 0;
  }
  if (command === '--version') {
    const metadata: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    if (typeof metadata !== 'object' || metadata === null || !('version' in metadata) || typeof metadata.version !== 'string') {
      throw new Error('Fleet Runner package version is missing.');
    }
    context.stdout.write(`fleet-runner ${metadata.version}\n`);
    return 0;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    context.stderr.write(`fleet-runner: unknown command "${command}". See: fleet-runner help\n`);
    return 2;
  }
  try {
    return await handler(context, rest);
  } catch (error) {
    if (error instanceof FleetError) {
      context.stderr.write(`fleet-runner: ${error.message}\n`);
      for (const detail of error.details) context.stderr.write(`  ${detail}\n`);
      return error.exitCode;
    }
    throw error;
  }
}

export function defaultContext(): CliContext {
  return {
    paths: resolveStatePaths(),
    stdout: process.stdout,
    stderr: process.stderr,
    transportFor: (machine) => SshTransport.forMachine(machine),
    interrupts: new Interrupts(),
  };
}
