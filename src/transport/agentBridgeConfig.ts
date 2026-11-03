// Reads the connection route for one Agent Bridge target.
//
// Fleet Runner reuses Agent Bridge's existing pairing instead of storing its
// own hosts or keys. This mirrors `agent-bridge run` (v4.x): the INI-style
// ~/.agent-bridge/config has one [Target] section per paired machine with
// host/user/port, identity_file (or the older key=), and optional
// internet_host/internet_port. Since Agent Bridge 3.4.2 the internet (Tailscale)
// endpoint is used whenever it is configured, with no LAN fallback, and the
// same applies here.
//
// Only these non-secret fields are read. The identity file is passed to ssh by
// path and never opened. Values are validated so a malformed config cannot
// inject ssh options (for example a host beginning with "-"), and error
// messages name the field, never its value.
//
// Why not shell out to `agent-bridge run`? It prints status lines on stdout,
// which would corrupt job output and binary artifact transfer, and it offers
// no stdin channel for uploads. Building the identical ssh invocation from the
// same config keeps the proven route without those side effects.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FleetError } from '../errors.ts';
import { expandHome } from '../paths.ts';

export interface AgentBridgeRoute {
  readonly target: string;
  readonly host: string;
  readonly user: string;
  readonly port: number;
  readonly identityFile?: string;
  /** "internet" when internet_host (Tailscale) is configured, otherwise "lan". */
  readonly path: 'internet' | 'lan';
}

/** Agent Bridge's own resolution: AGENT_BRIDGE_HOME (state dir or its parent), else ~/.agent-bridge. */
export function defaultAgentBridgeConfigPath(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment['AGENT_BRIDGE_HOME'];
  if (override !== undefined && override !== '') {
    const expanded = expandHome(override);
    if (existsSync(join(expanded, 'config')) || expanded.endsWith('.agent-bridge')) return join(expanded, 'config');
    return join(expanded, '.agent-bridge', 'config');
  }
  return join(homedir(), '.agent-bridge', 'config');
}

/** Parses the INI text into sections (case-insensitive section names, like cfg_get). */
export function parseAgentBridgeConfig(text: string): Map<string, { name: string; values: Map<string, string> }> {
  const sections = new Map<string, { name: string; values: Map<string, string> }>();
  let current: { name: string; values: Map<string, string> } | undefined;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      const name = header[1] ?? '';
      current = { name, values: new Map() };
      // First section wins, matching cfg_get's first-match scan.
      if (!sections.has(name.toLowerCase())) sections.set(name.toLowerCase(), current);
      continue;
    }
    const pair = /^([a-z_]+)=(.*)$/.exec(line);
    if (pair && current && !current.values.has(pair[1] ?? '')) current.values.set(pair[1] ?? '', pair[2] ?? '');
  }
  return sections;
}

const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.:_-]*$/;
const USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export function resolveAgentBridgeRoute(target: string, configText: string): AgentBridgeRoute {
  const section = parseAgentBridgeConfig(configText).get(target.toLowerCase());
  if (!section) throw new FleetError('usage', `Agent Bridge has no paired target "${target}". Check: agent-bridge list`);
  const field = (key: string): string | undefined => {
    const value = section.values.get(key);
    return value === undefined || value === '' ? undefined : value;
  };
  const internetHost = field('internet_host');
  const host = internetHost ?? field('host');
  const portText = internetHost !== undefined ? field('internet_port') ?? '22' : field('port') ?? '22';
  const user = field('user');
  if (host === undefined) throw new FleetError('usage', `Agent Bridge target "${section.name}" has no host.`);
  if (!HOST_PATTERN.test(host)) throw new FleetError('usage', `Agent Bridge target "${section.name}" has an unusable host value.`);
  if (user === undefined || !USER_PATTERN.test(user)) throw new FleetError('usage', `Agent Bridge target "${section.name}" has no usable user.`);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new FleetError('usage', `Agent Bridge target "${section.name}" has an invalid port.`);
  const keyValue = field('identity_file') ?? field('key');
  const identityFile = keyValue === undefined || keyValue === '(system default)' ? undefined : expandHome(keyValue);
  if (identityFile !== undefined && (!identityFile.startsWith('/') || identityFile.includes('\n'))) {
    throw new FleetError('usage', `Agent Bridge target "${section.name}" has an unusable identity file path.`);
  }
  return {
    target: section.name,
    host,
    user,
    port,
    path: internetHost !== undefined ? 'internet' : 'lan',
    ...(identityFile === undefined ? {} : { identityFile }),
  };
}

/** One paired computer, as `agent-bridge list` shows it: every config section. */
export interface AgentBridgePairing {
  readonly target: string;
  /** The route The Fleet would use, or why it cannot use this pairing. */
  readonly route?: AgentBridgeRoute;
  readonly problem?: string;
  readonly pairedAt?: string;
}

export function listAgentBridgePairings(configText: string): AgentBridgePairing[] {
  return [...parseAgentBridgeConfig(configText).values()].map((section) => {
    const pairedAt = section.values.get('paired_at');
    const extra = pairedAt ? { pairedAt } : {};
    try {
      return { target: section.name, route: resolveAgentBridgeRoute(section.name, configText), ...extra };
    } catch (error) {
      return { target: section.name, problem: error instanceof Error ? error.message : 'Unusable pairing', ...extra };
    }
  });
}

export function loadAgentBridgeRoute(target: string, configPath: string | undefined): AgentBridgeRoute {
  const path = configPath === undefined ? defaultAgentBridgeConfigPath() : expandHome(configPath);
  if (!existsSync(path)) throw new FleetError('usage', `Agent Bridge config not found (${path}). Pair the machine with Agent Bridge first.`);
  return resolveAgentBridgeRoute(target, readFileSync(path, 'utf8'));
}
