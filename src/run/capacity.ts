// Shared admission claims for coordinator policy and the remote kernel guard.
// Ethan's "one task shouldn't own anything" means ordinary work consumes a
// bounded slot, while maintenance and real conflicts retain explicit ownership.
import type { Profile } from '../schema/manifest.ts';
import type { Machine } from '../schema/machines.ts';
import { Reader } from '../schema/validate.ts';

export interface CapacityClaim {
  readonly mode: 'shared' | 'exclusive' | 'drain';
  readonly resources: readonly string[];
  readonly workload?: 'standard' | 'e2e';
  readonly cache?: { readonly name: string; readonly concurrent: boolean };
}

export function parseClaim(value: unknown): CapacityClaim {
  const reader = new Reader('capacity claim');
  const raw = reader.object(value, ['mode', 'resources', 'cache', 'workload']);
  const mode = reader.child('mode').string(raw['mode']);
  if (mode !== 'shared' && mode !== 'exclusive' && mode !== 'drain') reader.child('mode').fail('must be shared, exclusive or drain');
  const resources = reader.child('resources').optionalStringArray(raw['resources'], { pattern: /^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,199}$/, patternHint: 'use a short named worker resource' }) ?? [];
  if (resources.length > 32) reader.child('resources').fail('at most 32 resources');
  const workload = reader.child('workload').optionalString(raw['workload']);
  if (workload !== undefined && workload !== 'standard' && workload !== 'e2e') reader.child('workload').fail('must be standard or e2e');
  let cache: CapacityClaim['cache'];
  if (raw['cache'] !== undefined) {
    const child = reader.child('cache');
    const item = child.object(raw['cache'], ['name', 'concurrent']);
    cache = { name: child.child('name').string(item['name'], { pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/, patternHint: 'use a cache identifier' }), concurrent: child.child('concurrent').optionalBoolean(item['concurrent']) ?? false };
  }
  return { mode: mode as CapacityClaim['mode'], resources: [...new Set(resources)].sort(), ...(cache ? { cache } : {}), ...(workload === 'standard' || workload === 'e2e' ? { workload } : {}) };
}

/** Ethan's "double simultaneous jobs; E2Es can remain as is": independent ceilings,
 * rather than making a browser suite and a quick typecheck cost the same budget.
 * Explicit metadata covers opaque shell wrappers; familiar names retain older recipes.
 */
export function profileWorkload(profile: Pick<Profile, 'name' | 'argv' | 'workload'>, extraArgs: readonly string[] = []): 'standard' | 'e2e' {
  return profile.workload ?? (/(?:^|[\s/:._-])(?:e2e|playwright|cypress)(?=$|[\s/:._-])/i.test([profile.name, ...profile.argv, ...extraArgs].join(' ')) ? 'e2e' : 'standard');
}

export function e2eLimit(machine: Machine): number {
  return Math.min(machine.limits.maxConcurrentE2eJobs ?? machine.limits.maxConcurrentJobs, machine.limits.maxConcurrentJobs);
}

export function profileClaim(profile: Profile, machine: Machine): CapacityClaim {
  return {
    workload: profileWorkload(profile),
    mode: profile.exclusive || machine.limits.maxConcurrentJobs === 1 ? 'exclusive' : 'shared',
    resources: [...new Set([...(profile.resources ?? []), ...(profile.requires.guiSession ? ['desktop'] : [])])].sort(),
    ...(profile.cache ? { cache: { name: profile.cache.name, concurrent: profile.cache.concurrent === true } } : {}),
  };
}

export function claimsConflict(left: CapacityClaim, right: CapacityClaim): boolean {
  return left.mode !== 'shared' || right.mode !== 'shared'
    || left.resources.some((resource) => right.resources.includes(resource))
    || (left.cache !== undefined && right.cache !== undefined && left.cache.name === right.cache.name && (!left.cache.concurrent || !right.cache.concurrent));
}
