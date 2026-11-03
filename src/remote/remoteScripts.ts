// Builds the remote commands that run Fleet Runner's bash scripts.
//
// The scripts in ../../remote are sent inline on every invocation
// (`/bin/bash -c '<lib.sh + script>' name args...`) rather than installed on
// the fleet machine. That avoids version skew between this CLI and the
// machine, needs no setup step there, and leaves nothing behind except the
// managed .noindex root. Every argument is a single quoted shell word.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Machine } from '../schema/machines.ts';
import type { Profile } from '../schema/manifest.ts';
import { profileClaim } from '../run/capacity.ts';
import { inlineBashCommand, remotePathWord, shellQuote } from '../transport/shellQuote.ts';

const REMOTE_DIRECTORY = new URL('../../remote/', import.meta.url);

function loadScript(name: 'supervisor.sh' | 'preflight.sh' | 'control.sh'): string {
  const library = readFileSync(fileURLToPath(new URL('lib.sh', REMOTE_DIRECTORY)), 'utf8');
  const script = readFileSync(fileURLToPath(new URL(name, REMOTE_DIRECTORY)), 'utf8');
  return `${library}\n${script}`;
}

function guardedCommand(machine: Machine, mode: 'supervisor' | 'shared' | 'clear', script: string, name: string, args: string[]): string {
  const guard = readFileSync(fileURLToPath(new URL('guard.py', REMOTE_DIRECTORY)), 'utf8');
  return ['python3', '-c', shellQuote(guard), remotePathWord(machine.remoteRoot), shellQuote(mode), shellQuote(script), shellQuote(name), ...args].join(' ');
}

export interface SupervisorArguments {
  readonly jobId: string;
  readonly nonce: string;
  readonly timeoutSeconds: number;
  readonly label: string;
  readonly profile?: Profile;
}

export function supervisorCommand(machine: Machine, args: SupervisorArguments): string {
  const claim = args.profile ? profileClaim(args.profile, machine) : undefined;
  const shared = claim?.mode === 'shared';
  return guardedCommand(machine, shared ? 'shared' : 'supervisor', loadScript('supervisor.sh'), 'fleet-runner-supervisor', [
    remotePathWord(machine.remoteRoot),
    shellQuote(args.jobId),
    shellQuote(args.nonce),
    shellQuote(String(Math.round(args.timeoutSeconds))),
    shellQuote(String(machine.limits.terminateGraceSeconds)),
    shellQuote(String(Math.round(machine.limits.uploadTimeoutMinutes * 60))),
    shellQuote(String(machine.limits.keepJobs)),
    shellQuote(args.label),
    shellQuote(JSON.stringify({ slots: machine.limits.maxConcurrentJobs, resources: claim?.resources ?? [], cache: claim?.cache, cacheMaxKiB: args.profile?.cache ? Math.round(args.profile.cache.maxGiB * 1024 ** 2) : 0 })),
  ]);
}

export function preflightCommand(machine: Machine, extraPathPrepend: readonly string[], tools: readonly string[]): string {
  return inlineBashCommand(loadScript('preflight.sh'), 'fleet-runner-preflight', [
    remotePathWord(machine.remoteRoot),
    shellQuote([...extraPathPrepend, ...machine.pathPrepend].join(':')),
    shellQuote(tools.join(',')),
    shellQuote(machine.limits.heavyProcessNames.join(',')),
  ]);
}

export type ControlAction = 'status' | 'cancel' | 'clear-stale' | 'reap-stale';

export function controlCommand(machine: Machine, action: ControlAction, expectedJobId?: string): string {
  const args = [
    remotePathWord(machine.remoteRoot),
    shellQuote(action),
    shellQuote(String(machine.limits.terminateGraceSeconds)),
    shellQuote(expectedJobId ?? ''),
  ];
  return action === 'clear-stale' || action === 'reap-stale'
    ? guardedCommand(machine, 'clear', loadScript('control.sh'), 'fleet-runner-control', args)
    : inlineBashCommand(loadScript('control.sh'), 'fleet-runner-control', args);
}

/**
 * Extracts the upload stream into the job folder the supervisor created.
 * Refuses unless the folder carries the supervisor's marker and has no
 * src/meta yet, so an upload can never overwrite another checkout.
 */
export function uploadCommand(jobDirectory: string): string {
  const script = readFileSync(fileURLToPath(new URL('upload.py', REMOTE_DIRECTORY)), 'utf8');
  return ['python3', '-c', shellQuote(script), shellQuote(jobDirectory)].join(' ');
}

export function rsyncReceiverCommand(jobDirectory: string): string {
  // Like finalize.py, these are disposable job metadata, never installed or
  // retained in the source cache. Keeping code out of --rsync-path also avoids
  // openrsync interpreting Python's quotes while splitting the remote command.
  return ['python3', shellQuote(`${jobDirectory}/meta/rsync-receive.py`), shellQuote(jobDirectory), shellQuote(`${jobDirectory}/meta/rsync-worker.py`)].join(' ');
}

export function recoveryCommand(machine: Machine, jobId: string): string {
  const script = readFileSync(fileURLToPath(new URL('recover.py', REMOTE_DIRECTORY)), 'utf8');
  return ['python3', '-c', shellQuote(script), remotePathWord(machine.remoteRoot), shellQuote(jobId)].join(' ');
}
