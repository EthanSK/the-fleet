// Job commands: run, status, cancel, lock clear, results.

import { FleetError, usageError } from '../errors.ts';
import { loadMachines, loadProject, resolveSourceRoot, selectMachine } from '../registry.ts';
import { describeLock, formatDuration } from '../run/preflight.ts';
import { classifyRun, listReceipts, readReceipt } from '../run/receipt.ts';
import { fetchStatus, runControl } from '../run/remoteChecks.ts';
import { runProfile } from '../run/runJob.ts';
import { expectPositionals, parseArgs, single } from './args.ts';
import { print, status, type CliContext } from './context.ts';
import { printPlan } from './projectCommands.ts';
import { recoverArtifacts } from '../run/recoverArtifacts.ts';
import { defaultMachineNames, orderedMachines, runOnOrderedMachines } from '../run/orderedMachines.ts';
import { reportDiskSpaceProblem } from '../run/diskSpace.ts';

export async function recoverCommand(context: CliContext, argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { values: ['machine'] });
  const [jobId = ''] = expectPositionals(args, ['job-id'], 'fleet-runner recover <job-id> [--machine <name>]');
  const machine = selectMachine(loadMachines(context.paths), single(args, 'machine'), undefined);
  const path = await recoverArtifacts(context.paths, context.transportFor(machine), machine, jobId);
  print(context, `Recovered verified artifacts: ${path}`);
  return 0;
}

export async function runCommand(context: CliContext, argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { flags: ['dry-run', 'ignore-heavy-processes'], values: ['source', 'machine', 'machines'] });
  const workerNames = single(args, 'machines');
  if (workerNames !== undefined && single(args, 'machine') !== undefined) throw usageError('Use --machine or --machines, not both.');
  if (workerNames !== undefined && args.flags.has('dry-run')) throw usageError('Use plan --machine <name> to inspect a worker before running --machines.');
  const [projectId = '', profileName = ''] = expectPositionals(args, ['project', 'profile'], 'fleet-runner run <project> <profile> [--source <dir>] [--machine <name> | --machines <name,...>] [--dry-run] [--ignore-heavy-processes] [-- extra args]');
  if (args.flags.has('dry-run')) {
    return printPlan(context, projectId, profileName, args.passthrough, {
      source: single(args, 'source'),
      machine: single(args, 'machine'),
      files: false,
      preflight: true,
      json: false,
      ignoreHeavyProcesses: args.flags.has('ignore-heavy-processes'),
    });
  }
  const project = loadProject(context.paths, projectId);
  const source = single(args, 'source');
  const sourceRoot = source === undefined ? project.entry.sourceRoot : resolveSourceRoot(project.entry.manifestPath, project.manifest, source);
  const common = {
    paths: context.paths, project, profileName, sourceRoot, extraArgs: args.passthrough,
    ignoreHeavyProcesses: args.flags.has('ignore-heavy-processes'),
    io: { stdout: context.stdout, stderr: context.stderr, status: (line: string) => status(context, line),
      ...(context.onDiskSpaceProblem ? { onDiskSpaceProblem: context.onDiskSpaceProblem } : {}) },
    interrupts: context.interrupts,
  };
  const automatic = workerNames === undefined && single(args, 'machine') === undefined && project.manifest.defaultMachine === undefined;
  if (workerNames !== undefined || automatic) {
    const registry = loadMachines(context.paths);
    const result = await runOnOrderedMachines({ ...common, automatic, machines: orderedMachines(registry, workerNames?.split(',') ?? defaultMachineNames(registry)), transportFor: context.transportFor,
      ...(context.selectionUsage ? { selectionUsage: context.selectionUsage } : {}),
      ...(context.runOne ? { runOne: context.runOne } : {}), ...(context.beforePreflight ? { beforePreflight: context.beforePreflight } : {}) });
    return result.exitCode;
  }
  const machine = selectMachine(loadMachines(context.paths), single(args, 'machine'), project.manifest.defaultMachine);
  const result = await (context.runOne ?? runProfile)({
    paths: context.paths,
    project,
    profileName,
    machine,
    transport: context.transportFor(machine),
    sourceRoot,
    extraArgs: args.passthrough,
    ignoreHeavyProcesses: args.flags.has('ignore-heavy-processes'),
    io: { stdout: context.stdout, stderr: context.stderr, status: (line) => status(context, line),
      ...(context.onDiskSpaceProblem ? { onDiskSpaceProblem: context.onDiskSpaceProblem } : {}) },
    interrupts: context.interrupts,
  });
  if (result === null) throw new FleetError('machineBusy', `${machine.id} is reserved by another client.`);
  return result.exitCode;
}

export async function statusCommand(context: CliContext, argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { values: ['machine'] });
  expectPositionals(args, [], 'fleet-runner status [--machine <name>]');
  const machine = selectMachine(loadMachines(context.paths), single(args, 'machine'), undefined);
  const remote = await fetchStatus(context.transportFor(machine), machine);
  const now = Math.floor(Date.now() / 1000);
  const locks = [remote.lock, ...(remote.sharedLocks ?? [])].filter((lock) => lock.state !== 'free');
  if (!locks.length) print(context, `${machine.id} is free`);
  for (const lock of locks) {
    const finding = describeLock(machine, lock, now);
    if (finding) print(context, finding.message);
  }
  if (remote.jobsKiB !== undefined) print(context, `Retained job folders: ${(remote.jobsKiB / 1024).toFixed(1)} MiB (evidence and any unacknowledged outputs or failed cleanup)`);
  for (const cache of remote.caches) print(context, `Cache ${cache.name}: ${(cache.kib / 1024).toFixed(1)} MiB`);
  if (remote.jobs.length > 0) {
    print(context, 'Recent jobs:');
    for (const job of remote.jobs) {
      const duration = job.startedEpoch !== undefined && job.endedEpoch !== undefined ? ` ${formatDuration(job.endedEpoch - job.startedEpoch)}` : '';
      const exit = job.exitCode === '' || job.exitCode === '-' ? '' : ` exit ${job.exitCode}`;
      print(context, `  ${job.jobId}  ${job.reason}${exit}${duration}`);
    }
  }
  return 0;
}

export async function cancelCommand(context: CliContext, argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { values: ['machine', 'job'] });
  expectPositionals(args, [], 'fleet-runner cancel [--machine <name>] [--job <job-id>]');
  const machine = selectMachine(loadMachines(context.paths), single(args, 'machine'), undefined);
  const jobId = single(args, 'job');
  const target = jobId ? ` --job ${jobId}` : '';
  const { result, detail } = await runControl(context.transportFor(machine), machine, 'cancel', jobId);
  switch (result) {
    case 'nothing-running':
      print(context, `Nothing is running on ${machine.id}.`);
      return 0;
    case 'cancel-requested':
      print(context, `Asked ${machine.id} to cancel job ${detail}. Its supervisor stops the job and releases the lock.`);
      return 0;
    case 'stopped-orphaned':
      print(context, `Stopped leftover processes from job ${detail}. Clear the lock with: fleet-runner lock clear --machine ${machine.id}${target}`);
      return 0;
    case 'stale':
      print(context, `No job is running; the lock is stale. Clear it with: fleet-runner lock clear --machine ${machine.id}${target}`);
      return 0;
    case 'unverified':
      if (detail === 'specify-job-id') throw new FleetError('machineBusy', `${machine.id} has shared jobs. Specify one with --job <job-id>. Run: fleet-runner status --machine ${machine.id}`);
      throw new FleetError('machineBusy', `Can't confirm the running processes belong to job ${detail}. Nothing was stopped.`);
    default:
      throw new FleetError('transport', `Unexpected answer from ${machine.id}: ${result}`);
  }
}

export async function lockCommand(context: CliContext, argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { values: ['machine', 'job'] });
  const [action = ''] = expectPositionals(args, ['action'], 'fleet-runner lock clear [--machine <name>] [--job <job-id>]');
  if (action !== 'clear') throw usageError('Usage: fleet-runner lock clear [--machine <name>] [--job <job-id>]');
  const machine = selectMachine(loadMachines(context.paths), single(args, 'machine'), undefined);
  const jobId = single(args, 'job');
  const target = jobId ? ` --job ${jobId}` : '';
  const { result, detail, diskSpaceProblem } = await runControl(context.transportFor(machine), machine, 'clear-stale', jobId);
  if (diskSpaceProblem) reportDiskSpaceProblem(context.onDiskSpaceProblem, diskSpaceProblem);
  switch (result) {
    case 'free':
      print(context, `${machine.id} has no lock.`);
      return 0;
    case 'cleared':
      print(context, `Cleared the stale lock from job ${detail} on ${machine.id}.`);
      return 0;
    case 'busy':
      throw new FleetError('machineBusy', `${machine.id}'s lock is held by a running job, so it was kept. Cancel it with: fleet-runner cancel --machine ${machine.id}${target}`);
    case 'unverified':
      if (detail === 'specify-job-id') throw new FleetError('machineBusy', `${machine.id} has shared jobs. Specify one with --job <job-id>. Run: fleet-runner status --machine ${machine.id}`);
      throw new FleetError('machineBusy', `Can't confirm lock ownership for job ${detail}. Nothing was cleared.`);
    case 'artifact-capture-failed':
      throw new FleetError('transport', `Outputs for ${detail} could not be saved. The lock and source were kept; inspect artifact-capture.log before retrying explicit lock clear.`);
    case 'finalizer-failed':
      throw new FleetError('transport', `Finalizer for ${detail} failed. The lock and source were kept; inspect finalizer.log before retrying explicit lock clear.`);
    default:
      throw new FleetError('transport', `Unexpected answer from ${machine.id}: ${result}`);
  }
}

export async function resultsCommand(context: CliContext, argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { flags: ['json'], values: ['project', 'limit'] });
  if (args.positionals.length > 1) throw usageError('Usage: fleet-runner results [<job-id>] [--project <project>] [--limit <n>] [--json]');
  const jobId = args.positionals[0];
  if (jobId !== undefined) {
    const receipt = await readReceipt(context.paths, jobId);
    if (args.flags.has('json')) {
      print(context, JSON.stringify(receipt, null, 2));
      return 0;
    }
    // Text shows the canonical outcome, as apps do; --json keeps the recorded receipt.
    print(context, `${receipt.jobId}  ${classifyRun(receipt).outcome}`);
    print(context, `  ${receipt.summary}`);
    print(context, `  Project   ${receipt.project}/${receipt.profile} on ${receipt.machine.id}`);
    print(context, `  Source    ${receipt.source.digest.slice(0, 16)} · ${receipt.source.files} files${receipt.source.git?.head ? ` · from ${receipt.source.git.head.slice(0, 12)}` : ''}`);
    print(context, `  Started   ${receipt.timing.remoteStartedAt ?? 'not started'}`);
    for (const check of receipt.success.checks) print(context, `  ${check.passed ? '✓' : '✗'} ${check.name}: ${check.detail}`);
    for (const artifact of receipt.artifacts.slice(0, 20)) print(context, `  Artifact  ${artifact.path} ${artifact.sha256.slice(0, 16)}`);
    if (receipt.artifacts.length > 20) print(context, `  Artifact  ${receipt.artifacts.length - 20} more in receipt.json`);
    print(context, `  Folder    ${context.paths.runsDir}/${receipt.jobId}`);
    return 0;
  }
  const limitText = single(args, 'limit');
  const limit = limitText === undefined ? 20 : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1) throw usageError('--limit must be a positive whole number.');
  const project = single(args, 'project');
  const receipts = (await listReceipts(context.paths)).filter((receipt) => project === undefined || receipt.project === project).slice(0, limit);
  if (args.flags.has('json')) {
    print(context, JSON.stringify(receipts, null, 2));
    return 0;
  }
  if (receipts.length === 0) {
    print(context, 'No runs yet.');
    return 0;
  }
  for (const receipt of receipts) print(context, `${receipt.jobId}  ${classifyRun(receipt).outcome.padEnd(9)}  ${receipt.summary}`);
  return 0;
}
