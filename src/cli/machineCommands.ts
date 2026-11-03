// Machine commands: list machines and add one to the private registry.
//
// `machine add` only records the Agent Bridge target name, aliases and the
// managed root. It checks the target exists in Agent Bridge's config but never
// copies its host, user or key into Fleet Runner's files.

import { usageError } from '../errors.ts';
import { loadMachines, saveMachines } from '../registry.ts';
import { DEFAULT_LIMITS, findMachine, type Machine } from '../schema/machines.ts';
import { loadAgentBridgeRoute } from '../transport/agentBridgeConfig.ts';
import { expectPositionals, parseArgs, single } from './args.ts';
import { print, type CliContext } from './context.ts';

export const DEFAULT_REMOTE_ROOT = '~/FleetRunner.noindex';

export function machinesCommand(context: CliContext, argv: readonly string[]): number {
  parseArgs(argv, {});
  const registry = loadMachines(context.paths);
  if (registry.machines.length === 0) {
    print(context, 'No machines registered. Add one with: fleet-runner machine add <id> --bridge-target <Agent Bridge target>');
    return 0;
  }
  for (const machine of registry.machines) {
    const isDefault = registry.defaultMachine !== undefined && findMachine(registry, registry.defaultMachine)?.id === machine.id;
    print(context, `${machine.id}${isDefault ? ' (default)' : ''}`);
    print(context, `  Agent Bridge target  ${machine.transport.target}`);
    if (machine.aliases.length > 0) print(context, `  Aliases              ${machine.aliases.join(', ')} (same machine, same lock)`);
    print(context, `  Remote root          ${machine.remoteRoot}`);
    if (machine.pathPrepend.length > 0) print(context, `  PATH prepend         ${machine.pathPrepend.join(':')}`);
    if (Object.keys(machine.env).length > 0) print(context, `  Env                  ${Object.keys(machine.env).join(', ')}`);
  }
  return 0;
}

export function machineCommand(context: CliContext, argv: readonly string[]): number {
  const [action, ...rest] = argv;
  if (action !== 'add') throw usageError('Usage: fleet-runner machine add <id> --bridge-target <name> [--alias <name>]... [--remote-root <path>] [--path-prepend <dir>]... [--default] [--replace]');
  const args = parseArgs(rest, { flags: ['default', 'replace'], values: ['bridge-target', 'alias', 'remote-root', 'path-prepend'] });
  const [id = ''] = expectPositionals(args, ['id'], 'fleet-runner machine add <id> --bridge-target <name>');
  const target = single(args, 'bridge-target');
  if (target === undefined) throw usageError('--bridge-target is required (the name shown by: agent-bridge list).');
  // Confirms the pairing exists; the route details stay in Agent Bridge's config.
  loadAgentBridgeRoute(target, undefined);
  const registry = loadMachines(context.paths);
  const existing = registry.machines.find((machine) => machine.id === id);
  if (existing && !args.flags.has('replace')) throw usageError(`Machine ${id} already exists. Use --replace to update it.`);
  const machine: Machine = {
    id,
    transport: { kind: 'agent-bridge', target },
    aliases: [...(args.values.get('alias') ?? [])],
    remoteRoot: single(args, 'remote-root') ?? DEFAULT_REMOTE_ROOT,
    pathPrepend: [...(args.values.get('path-prepend') ?? existing?.pathPrepend ?? [])],
    env: existing?.env ?? {},
    limits: existing?.limits ?? DEFAULT_LIMITS,
  };
  const machines = [...registry.machines.filter((candidate) => candidate.id !== id), machine];
  const defaultMachine = args.flags.has('default') || registry.machines.length === 0 ? id : registry.defaultMachine;
  saveMachines(context.paths, { schemaVersion: 1, machines, ...(defaultMachine === undefined ? {} : { defaultMachine }) });
  print(context, `${existing ? 'Updated' : 'Added'} machine ${id} (Agent Bridge target ${target}, root ${machine.remoteRoot})`);
  print(context, `Check it with: fleet-runner doctor --machine ${id}`);
  return 0;
}
