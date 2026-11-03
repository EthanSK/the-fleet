// `fleet-runner doctor`: read-only health check of this Mac, the fleet
// machine(s) and registered projects.
//
// It never runs a profile, builds, installs, downloads or starts an agent. It
// reads local files (manifests, source tree for the snapshot plan, Agent
// Bridge's non-secret route fields, the identity file's permissions but not its
// contents) and runs the read-only remote machine check. For each alias that
// is itself an Agent Bridge target it runs the same check through that route
// and compares a hashed hardware fingerprint, so "Mac-Mini" and
// "Ethans-Mac-mini" are confirmed to reach one machine and therefore one lock.

import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { listRegistrations, loadMachines, loadProject, selectMachine } from '../registry.ts';
import { evaluatePreflight, describeLock, formatGiB, type PreflightReport } from '../run/preflight.ts';
import { fetchPreflight } from '../run/remoteChecks.ts';
import type { Machine } from '../schema/machines.ts';
import type { ProjectManifest } from '../schema/manifest.ts';
import { planSnapshot, formatMiB } from '../snapshot/select.ts';
import { loadAgentBridgeRoute } from '../transport/agentBridgeConfig.ts';
import { SshTransport } from '../transport/sshTransport.ts';
import { parseArgs, single } from './args.ts';
import { homeRelative, print, type CliContext } from './context.ts';

type Level = 'ok' | 'warn' | 'fail';

class Report {
  failures = 0;
  private readonly context: CliContext;

  constructor(context: CliContext) {
    this.context = context;
  }

  section(title: string): void {
    print(this.context, title);
  }

  line(level: Level, message: string): void {
    if (level === 'fail') this.failures += 1;
    print(this.context, `  ${level.padEnd(4)}  ${message}`);
  }
}

export async function doctorCommand(context: CliContext, argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { values: ['machine', 'project'] });
  const report = new Report(context);

  report.section('This Mac');
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  report.line(major > 22 || (major === 22 && minor >= 18) ? 'ok' : 'fail', `Node ${process.versions.node} (needs 22.18+ to run TypeScript directly)`);
  const ssh = spawnSync('ssh', ['-V'], { encoding: 'utf8' });
  report.line(ssh.error ? 'fail' : 'ok', ssh.error ? 'ssh not found' : `ssh ${(ssh.stderr || ssh.stdout).trim().split(',')[0] ?? ''}`);
  report.line('ok', `State folder ${homeRelative(context.paths.home)}`);

  const registry = loadMachines(context.paths);
  if (registry.machines.length === 0) {
    report.line('fail', 'No fleet machines registered. Add one with: fleet-runner machine add <id> --bridge-target <name>');
    return 3;
  }
  const projectId = single(args, 'project');
  const projects = projectId !== undefined ? [projectId] : listRegistrations(context.paths).map((entry) => entry.id);
  const loadedProjects: { id: string; manifest?: ProjectManifest; sourceRoot?: string; error?: string }[] = projects.map((id) => {
    try {
      const loaded = loadProject(context.paths, id);
      return { id, manifest: loaded.manifest, sourceRoot: loaded.entry.sourceRoot };
    } catch (error) {
      return { id, error: error instanceof Error ? error.message : String(error) };
    }
  });

  const machineName = single(args, 'machine');
  const machines = machineName !== undefined ? [selectMachine(registry, machineName, undefined)] : registry.machines;
  const fingerprints = new Map<string, string>();
  for (const machine of machines) {
    const tools = new Set<string>();
    const pathPrepend = new Set<string>();
    for (const project of loadedProjects) {
      for (const profile of Object.values(project.manifest?.profiles ?? {})) {
        profile.requires.tools.forEach((tool) => tools.add(tool));
        profile.pathPrepend.forEach((entry) => pathPrepend.add(entry));
      }
    }
    const preflight = await checkMachine(context, report, machine, [...pathPrepend], [...tools]);
    if (preflight?.fingerprint) {
      const other = fingerprints.get(preflight.fingerprint);
      if (other !== undefined) report.line('fail', `${machine.id} and ${other} are the same physical machine. Merge them into one entry (with aliases) so they share one lock.`);
      fingerprints.set(preflight.fingerprint, machine.id);
    }
    if (preflight) checkProjects(report, machine, preflight, loadedProjects);
  }

  for (const project of loadedProjects) {
    report.section(`Project ${project.id}`);
    if (project.error !== undefined || !project.manifest || project.sourceRoot === undefined) {
      report.line('fail', project.error ?? 'not loaded');
      continue;
    }
    try {
      const plan = await planSnapshot(project.sourceRoot, project.manifest.sync);
      report.line(plan.entries.length > 0 ? 'ok' : 'fail', `Source ${homeRelative(plan.root)}: ${plan.fileCount} files, ${formatMiB(plan.totalBytes)}`);
      for (const pattern of plan.unmatchedIncludes) report.line('warn', `sync.include "${pattern}" matches nothing`);
      for (const skipped of plan.skipped.slice(0, 5)) report.line('warn', `Not sent: ${skipped.relativePath} (${skipped.detail})`);
    } catch (error) {
      report.line('fail', error instanceof Error ? error.message : String(error));
    }
  }

  print(context);
  print(context, report.failures === 0 ? 'Doctor found no blocking problems.' : `Doctor found ${report.failures} problem${report.failures === 1 ? '' : 's'}.`);
  return report.failures === 0 ? 0 : 3;
}

async function checkMachine(context: CliContext, report: Report, machine: Machine, pathPrepend: string[], tools: string[]): Promise<PreflightReport | undefined> {
  report.section(`Machine ${machine.id} (Agent Bridge target ${machine.transport.target})`);
  try {
    const route = loadAgentBridgeRoute(machine.transport.target, machine.transport.configPath);
    report.line('ok', `Agent Bridge route: ${route.path === 'internet' ? 'internet (Tailscale) endpoint' : 'LAN endpoint'}`);
    if (route.identityFile !== undefined) {
      if (!existsSync(route.identityFile)) {
        report.line('fail', 'Agent Bridge identity file is missing');
      } else {
        const mode = statSync(route.identityFile).mode & 0o077;
        report.line(mode === 0 ? 'ok' : 'warn', mode === 0 ? 'Identity file present and private' : 'Identity file is readable by other users');
      }
    }
  } catch (error) {
    report.line('fail', error instanceof Error ? error.message : String(error));
    return undefined;
  }

  let preflight: PreflightReport;
  try {
    preflight = await fetchPreflight(context.transportFor(machine), machine, pathPrepend, tools);
  } catch (error) {
    report.line('fail', error instanceof Error ? error.message : String(error));
    return undefined;
  }
  report.line('ok', `Reached ${preflight.host ?? 'machine'} as ${preflight.user ?? '?'} (${preflight.os ?? '?'} ${preflight.arch ?? ''}, bash ${preflight.bashVersion ?? '?'})`);
  const decision = evaluatePreflight(preflight, machine, undefined, { ignoreHeavyProcesses: false, nowEpoch: Math.floor(Date.now() / 1000) });
  const refusalKinds = new Set(decision.refusals.map((finding) => finding.kind));
  if (preflight.diskFreeBytes !== undefined) {
    report.line(refusalKinds.has('disk') ? 'fail' : 'ok', `Free disk ${formatGiB(preflight.diskFreeBytes)} (minimum ${machine.limits.minFreeDiskGiB} GiB)`);
  }
  if (preflight.memAvailableBytes !== undefined) {
    report.line(refusalKinds.has('memory') ? 'warn' : 'ok', `Available memory about ${formatGiB(preflight.memAvailableBytes)} of ${formatGiB(preflight.memTotalBytes ?? 0)} (estimate from vm_stat; minimum ${machine.limits.minAvailableMemoryGiB} GiB)`);
  }
  if (preflight.memPressureLevel !== undefined) {
    const label = preflight.memPressureLevel >= 4 ? 'critical' : preflight.memPressureLevel >= 2 ? 'elevated' : 'normal';
    report.line(label === 'normal' ? 'ok' : 'warn', `Memory pressure ${label}${preflight.swapUsedMiB === undefined ? '' : ` · swap used ${Math.round(preflight.swapUsedMiB)} MiB`}`);
  }
  report.line('ok', preflight.guiSession ? `GUI session: ${preflight.user ?? 'remote user'} is the console user` : 'No GUI console session for the remote user (GUI profiles will refuse)');
  for (const finding of decision.refusals.filter((candidate) => candidate.kind === 'heavy' || candidate.kind === 'base-tool')) report.line(finding.kind === 'heavy' ? 'warn' : 'fail', finding.message);
  const lock = describeLock(machine, preflight.lock, Math.floor(Date.now() / 1000));
  report.line(lock === undefined ? 'ok' : 'warn', lock?.message ?? 'Heavy-job lock is free');
  if (!preflight.bsdtar) report.line('warn', 'Remote tar is not bsdtar; artifacts keep no macOS metadata either way');

  for (const alias of machine.aliases) {
    let aliasRoute;
    try {
      aliasRoute = loadAgentBridgeRoute(alias, machine.transport.configPath);
    } catch {
      report.line('ok', `Alias ${alias} is a name only (not an Agent Bridge target); it uses ${machine.transport.target}'s route and lock`);
      continue;
    }
    try {
      const aliasReport = await fetchPreflight(new SshTransport(aliasRoute), machine, [], []);
      const same = aliasReport.fingerprint === preflight.fingerprint && aliasReport.user === preflight.user;
      report.line(same ? 'ok' : 'fail', same ? `Alias ${alias} reaches the same machine and lock` : `Alias ${alias} reaches a different machine or user; give it its own machine entry`);
    } catch (error) {
      report.line('warn', `Alias ${alias} unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return preflight;
}

function checkProjects(report: Report, machine: Machine, preflight: PreflightReport, projects: { id: string; manifest?: ProjectManifest }[]): void {
  for (const project of projects) {
    if (!project.manifest) continue;
    for (const profile of Object.values(project.manifest.profiles)) {
      const label = `${project.id}/${profile.name}`;
      if (profile.blocked !== undefined) {
        report.line('warn', `${label} blocked: ${profile.blocked}`);
        continue;
      }
      const missingTools = profile.requires.tools.filter((tool) => preflight.tools.get(tool) !== true);
      const missingEnv = profile.requires.machineEnv.filter((name) => machine.env[name] === undefined);
      const problems = [
        ...(missingTools.length > 0 ? [`missing ${missingTools.join(', ')} on PATH`] : []),
        ...(missingEnv.length > 0 ? [`needs ${missingEnv.join(', ')} in ${machine.id}'s machine env`] : []),
        ...(profile.requires.guiSession && !preflight.guiSession ? ['needs the GUI session'] : []),
      ];
      report.line(problems.length === 0 ? 'ok' : 'fail', problems.length === 0 ? `${label} ready on ${machine.id}` : `${label}: ${problems.join('; ')}`);
    }
  }
}
