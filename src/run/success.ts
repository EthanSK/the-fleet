// Decides whether a finished job passed, from its exit status and output.
//
// The runner can't recognise every test framework, so a profile states its
// own success criteria (see manifest.ts). Exit status 0 is necessary but never
// sufficient for a test profile: "zero tests ran" must fail, which is what
// minTestCount and requireOutput are for. Colour escape codes are stripped
// before matching so a tool that colours its summary still matches.

import type { Profile } from '../schema/manifest.ts';

export interface SuccessCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface SuccessEvaluation {
  readonly passed: boolean;
  readonly checks: readonly SuccessCheck[];
  readonly testCount: number | null;
}

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPES = /\u001b\[[0-9;?]*[A-Za-z]/g;

export function evaluateSuccess(input: {
  readonly profile: Profile;
  readonly remoteReason: string;
  readonly exitCode: number | null;
  readonly output: string;
  readonly missingArtifacts: readonly string[];
}): SuccessEvaluation {
  const { profile } = input;
  const output = input.output.replace(ANSI_ESCAPES, '');
  const checks: SuccessCheck[] = [];

  checks.push({
    name: 'exit status',
    passed: input.remoteReason === 'completed' && input.exitCode === 0,
    detail: input.remoteReason === 'completed' ? `exit ${input.exitCode ?? 'unknown'}` : input.remoteReason,
  });

  for (const pattern of profile.success.requireOutput) {
    const found = new RegExp(pattern, 'm').test(output);
    checks.push({ name: `output contains /${pattern}/`, passed: found, detail: found ? 'found' : 'not found' });
  }
  for (const pattern of profile.success.rejectOutput) {
    const found = new RegExp(pattern, 'm').test(output);
    checks.push({ name: `output lacks /${pattern}/`, passed: !found, detail: found ? 'found' : 'absent' });
  }

  let testCount: number | null = null;
  const criterion = profile.success.minTestCount;
  if (criterion) {
    const regex = new RegExp(criterion.pattern, 'gm');
    for (const match of output.matchAll(regex)) {
      const value = Number.parseInt(match[1] ?? '', 10);
      if (Number.isFinite(value)) testCount = Math.max(testCount ?? 0, value);
    }
    checks.push({
      name: `at least ${criterion.min} test${criterion.min === 1 ? '' : 's'}`,
      passed: testCount !== null && testCount >= criterion.min,
      detail: testCount === null ? 'no test count found in output' : `${testCount} counted`,
    });
  }

  if (profile.artifacts.length > 0) {
    checks.push({
      name: 'declared artifacts returned',
      passed: input.missingArtifacts.length === 0,
      detail: input.missingArtifacts.length === 0 ? `${profile.artifacts.length} returned` : `missing: ${input.missingArtifacts.join(', ')}`,
    });
  }

  return { passed: checks.every((check) => check.passed), checks, testCount };
}
