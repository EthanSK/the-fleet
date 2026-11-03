// Project commands: register, unregister, list, show, validate, plan.
//
// `plan` is the dry run: it reads the source tree and renders the command, and
// with --preflight also runs the read-only machine check. It never uploads,
// builds, installs or downloads anything.

import { EXIT_CODES } from '../errors.ts';
import { listRegistrations, loadMachines, loadManifestFile, loadProject, registerProject, resolveSourceRoot, selectMachine, unregisterProject } from '../registry.ts';
import { evaluatePreflight, formatGiB } from '../run/preflight.ts';
import { fetchPreflight } from '../run/remoteChecks.ts';
import { getProfile, makeJobId, planRun } from '../run/runJob.ts';
import type { Profile } from '../schema/manifest.ts';
import { formatMiB } from '../snapshot/select.ts';
import { resolveFrom } from '../paths.ts';
import { shellJoin } from '../transport/shellQuote.ts';
import { expectPositionals, parseArgs, single } from './args.ts';
import { homeRelative, print, type CliContext } from './context.ts';

export function registerCommand(context: CliContext, argv: readonly string[]): number {
  const args = parseArgs(argv, { flags: ['replace'], values: ['source'] });
  const [manifestPath = ''] = expectPositionals(args, ['manifest'], 'fleet-runner register <manifest.json> [--source <dir>] [--replace]');
  const entry = registerProject(context.paths, manifestPath, single(args, 'source'), args.flags.has('replace'));
  print(context, `Registered ${entry.id}`);
  print(context, `  Manifest  ${homeRelative(entry.manifestPath)}`);
  print(context, `  Source    ${homeRelative(entry.sourceRoot)}`);
  print(context, `Next: fleet-runner plan ${entry.id} <profile>`);
  return 0;
}

export function unregisterCommand(context: CliContext, argv: readonly string[]): number {
  const args = parseArgs(argv, {});
  const [id = ''] = expectPositionals(args, ['project'], 'fleet-runner unregister <project>');
  unregisterProject(context.paths, id);
  print(context, `Unregistered ${id}`);
  return 0;
}

export function listCommand(context: CliContext, argv: readonly string[]): number {
  parseArgs(argv, {});
  const entries = listRegistrations(context.paths);
  if (entries.length === 0) {
    print(context, 'No projects registered. Register one with: fleet-runner register <manifest.json> [--source <dir>]');
    return 0;
  }
  for (const entry of entries) {
    try {
      const { manifest } = loadProject(context.paths, entry.id);
      const profiles = Object.values(manifest.profiles).map((profile) => (profile.blocked === undefined ? profile.name : `${profile.name} (blocked)`));
      print(context, `${entry.id}  ${profiles.join(', ')}`);
    } catch (error) {
      print(context, `${entry.id}  manifest error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return 0;
}

export function describeSuccess(profile: Profile): string {
  const parts = ['exit 0'];
  if (profile.success.minTestCount) parts.push(`at least ${profile.success.minTestCount.min} test(s) via /${profile.success.minTestCount.pattern}/`);
  for (const pattern of profile.success.requireOutput) parts.push(`output has /${pattern}/`);
  for (const pattern of profile.success.rejectOutput) parts.push(`output lacks /${pattern}/`);
  if (profile.artifacts.length > 0) parts.push('artifacts returned');
  return parts.join(' · ');
}

export function showCommand(context: CliContext, argv: readonly string[]): number {
  const args = parseArgs(argv, {});
  const [id = ''] = expectPositionals(args, ['project'], 'fleet-runner show <project>');
  const { entry, manifest } = loadProject(context.paths, id);
  print(context, manifest.description === undefined ? manifest.id : `${manifest.id} — ${manifest.description}`);
  print(context, `  Manifest  ${homeRelative(entry.manifestPath)}`);
  print(context, `  Source    ${homeRelative(entry.sourceRoot)}`);
  if (manifest.defaultMachine) print(context, `  Machine   ${manifest.defaultMachine}`);
  print(context, `  Sends     ${manifest.sync.include.join(', ')}`);
  if (manifest.sync.exclude.length > 0) print(context, `  Excludes  ${manifest.sync.exclude.join(', ')}`);
  for (const profile of Object.values(manifest.profiles)) {
    print(context);
    print(context, `${profile.name} (${profile.kind}) — ${profile.description}`);
    if (profile.blocked !== undefined) print(context, `  Blocked   ${profile.blocked}`);
    if (profile.extraInputs.length > 0) print(context, `  Also sends ${profile.extraInputs.join(', ')}`);
    if (profile.finalizer) print(context, `  Finalizer ${shellJoin(profile.finalizer.argv)} (timeout ${profile.finalizer.timeoutSeconds}s)`);
    for (const step of profile.prepare) print(context, `  Prepare   ${shellJoin(step)}`);
    print(context, `  Command   ${shellJoin(profile.argv)}${profile.allowExtraArgs ? ' [-- extra args]' : ''}`);
    if (profile.cwd !== '.') print(context, `  Cwd       ${profile.cwd}`);
    print(context, `  Timeout   ${profile.timeoutMinutes}m`);
    print(context, `  Success   ${describeSuccess(profile)}`);
    if (profile.artifacts.length > 0) print(context, `  Artifacts ${profile.artifacts.join(', ')}`);
    const requirements = [
      ...(profile.requires.tools.length > 0 ? [`tools ${profile.requires.tools.join(', ')}`] : []),
      ...(profile.requires.guiSession ? ['GUI session'] : []),
      ...(profile.requires.machineEnv.length > 0 ? [`machine env ${profile.requires.machineEnv.join(', ')}`] : []),
    ];
    if (requirements.length > 0) print(context, `  Requires  ${requirements.join(' · ')}`);
    if (profile.cache) print(context, `  Cache     ${profile.cache.name} (up to ${profile.cache.maxGiB} GiB)`);
  }
  if (manifest.localOnly.length > 0) {
    print(context);
    print(context, 'Local only (never run remotely):');
    for (const note of manifest.localOnly) print(context, `  ${note.command} — ${note.reason}`);
  }
  return 0;
}

export function validateCommand(context: CliContext, argv: readonly string[]): number {
  const args = parseArgs(argv, {});
  const [manifestPath = ''] = expectPositionals(args, ['manifest'], 'fleet-runner validate <manifest.json>');
  const manifest = loadManifestFile(resolveFrom(process.cwd(), manifestPath));
  const blocked = Object.values(manifest.profiles).filter((profile) => profile.blocked !== undefined).length;
  print(context, `${manifest.id}: valid, ${Object.keys(manifest.profiles).length} profiles${blocked > 0 ? ` (${blocked} blocked)` : ''}`);
  return 0;
}

export async function planCommand(context: CliContext, argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { flags: ['files', 'preflight', 'json', 'ignore-heavy-processes'], values: ['source', 'machine'] });
  const [projectId = '', profileName = ''] = expectPositionals(args, ['project', 'profile'], 'fleet-runner plan <project> <profile> [--source <dir>] [--machine <name>] [--files] [--preflight] [--json] [-- extra args]');
  return printPlan(context, projectId, profileName, args.passthrough, {
    source: single(args, 'source'),
    machine: single(args, 'machine'),
    files: args.flags.has('files'),
    preflight: args.flags.has('preflight'),
    json: args.flags.has('json'),
    ignoreHeavyProcesses: args.flags.has('ignore-heavy-processes'),
  });
}

export async function printPlan(
  context: CliContext,
  projectId: string,
  profileName: string,
  extraArgs: readonly string[],
  options: { source: string | undefined; machine: string | undefined; files: boolean; preflight: boolean; json: boolean; ignoreHeavyProcesses: boolean },
): Promise<number> {
  const project = loadProject(context.paths, projectId);
  const profile = getProfile(project, profileName);
  const machine = selectMachine(loadMachines(context.paths), options.machine, project.manifest.defaultMachine);
  const sourceRoot = options.source === undefined ? project.entry.sourceRoot : resolveSourceRoot(project.entry.manifestPath, project.manifest, options.source);
  const jobId = makeJobId(project.manifest.id, profile.name, new Date());
  const { plan, git, script, label } = await planRun({ project, profileName, machine, sourceRoot, extraArgs }, jobId);

  let preflightLines: string[] = [];
  let refused = false;
  let busy = false;
  if (options.preflight) {
    const report = await fetchPreflight(context.transportFor(machine), machine, profile.pathPrepend, profile.requires.tools);
    const decision = evaluatePreflight(report, machine, profile, { ignoreHeavyProcesses: options.ignoreHeavyProcesses, nowEpoch: Math.floor(Date.now() / 1000) });
    refused = decision.refusals.length > 0;
    busy = decision.refusals.some((finding) => finding.kind === 'busy' || finding.kind === 'stale');
    preflightLines = [
      ...(report.diskFreeBytes === undefined ? [] : [`free disk ${formatGiB(report.diskFreeBytes)}`]),
      ...(report.memAvailableBytes === undefined ? [] : [`available memory about ${formatGiB(report.memAvailableBytes)}`]),
      ...decision.refusals.map((finding) => `refuses: ${finding.message}`),
      ...decision.warnings.map((finding) => `warning: ${finding.message}`),
      ...(decision.refusals.length === 0 ? ['ready to run'] : []),
    ];
  }

  if (options.json) {
    print(context, JSON.stringify({
      project: project.manifest.id,
      profile: profile.name,
      machine: machine.id,
      source: { root: plan.root, digest: plan.digest, files: plan.fileCount, symlinks: plan.symlinkCount, bytes: plan.totalBytes, git },
      skipped: plan.skipped,
      unmatchedIncludes: plan.unmatchedIncludes,
      script,
      ...(options.files ? { entries: plan.entries.map((entry) => entry.relativePath) } : {}),
      ...(options.preflight ? { preflight: preflightLines, refused } : {}),
    }, null, 2));
  } else {
    print(context, `${label} on ${machine.id} (${machine.transport.target})`);
    print(context, `  Source    ${homeRelative(plan.root)}`);
    if (git) {
      const head = git.head === null ? 'no commits' : git.head.slice(0, 12);
      print(context, `  Git       ${head}${git.branch ? ` on ${git.branch}` : ''} · ${git.staged} staged, ${git.unstaged} unstaged, ${git.untracked} untracked (sent as on disk)`);
    }
    print(context, `  Selected  ${plan.fileCount} files${plan.symlinkCount > 0 ? `, ${plan.symlinkCount} links` : ''}, ${formatMiB(plan.totalBytes)} · digest ${plan.digest.slice(0, 16)}`);
    for (const skipped of plan.skipped) print(context, `  Not sent  ${skipped.relativePath} — ${skipped.detail}`);
    for (const pattern of plan.unmatchedIncludes) print(context, `  Unmatched ${pattern}`);
    for (const step of profile.prepare) print(context, `  Prepare   ${shellJoin(step)}`);
    print(context, `  Command   ${shellJoin([...profile.argv, ...extraArgs])}`);
    if (profile.cwd !== '.') print(context, `  Cwd       ${profile.cwd}`);
    const envNames = [...Object.keys(profile.env), ...Object.keys(machine.env)];
    if (envNames.length > 0) print(context, `  Env       ${envNames.join(', ')}`);
    print(context, `  Timeout   ${profile.timeoutMinutes}m (enforced on ${machine.id})`);
    print(context, `  Success   ${describeSuccess(profile)}`);
    if (profile.artifacts.length > 0) print(context, `  Artifacts ${profile.artifacts.join(', ')} (up to ${profile.maxArtifactMiB} MiB)`);
    if (options.files) for (const entry of plan.entries) print(context, `    ${entry.relativePath}${entry.kind === 'symlink' ? ` -> ${entry.linkTarget}` : ''}`);
    for (const line of preflightLines) print(context, `  Machine   ${line}`);
  }
  if (!options.preflight) return 0;
  return busy ? EXIT_CODES.machineBusy : refused ? EXIT_CODES.machineCheckRefused : EXIT_CODES.ok;
}
