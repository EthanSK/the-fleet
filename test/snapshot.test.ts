// Safe snapshot selection: explicit inputs, safety and default exclusions,
// symlink containment, dirty Git trees and exact digests.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SyncRules } from '../src/schema/manifest.ts';
import { readGitState } from '../src/snapshot/gitState.ts';
import { checkSymlinkTarget, planSnapshot } from '../src/snapshot/select.ts';
import { temporaryDirectory, writeFiles } from './helpers/fixtures.ts';

function rules(include: string[], extra: Partial<SyncRules> = {}): SyncRules {
  return { include, exclude: [], allowDefaultExcluded: [], maxTotalMiB: 64, maxFileMiB: 8, ...extra };
}

test('only included files are sent, and credentials never are', async () => {
  const directory = temporaryDirectory();
  try {
    const root = join(directory.path, 'project with spaces');
    writeFiles(root, {
      'Sources/App/main.swift': 'print(1)',
      'Sources/App/.env': 'SECRET=1',
      'Sources/App/.env.example': 'SECRET=',
      'Package.swift': '// pkg',
      'docs/readme.md': 'not included',
      '.git/config': '[core]',
      '.the-fleet/machines.json': '{"secret":"private"}',
      '.fleet-runner/reservations.json': '{"secret":"private"}',
      'Sources/App/deploy.pem': 'key',
    });
    const plan = await planSnapshot(root, rules(['Package.swift', 'Sources/**', '.git/**', '.the-fleet/**', '.fleet-runner/**']));
    const sent = plan.entries.map((entry) => entry.relativePath);
    assert.deepEqual(sent, ['Package.swift', 'Sources/App/.env.example', 'Sources/App/main.swift']);
    const blocked = plan.skipped.filter((entry) => entry.reason === 'safety-rule').map((entry) => entry.relativePath).sort();
    assert.deepEqual(blocked, ['.fleet-runner', '.git', '.the-fleet', 'Sources/App/.env', 'Sources/App/deploy.pem']);
  } finally {
    directory.cleanup();
  }
});

test('default exclusions apply unless explicitly allowed back in', async () => {
  const directory = temporaryDirectory();
  try {
    writeFiles(directory.path, {
      'index.js': '1',
      'node_modules/terser/index.js': 'terser',
      'node_modules/other/index.js': 'other',
      'build.noindex/out.o': 'binary',
      'data/live.sqlite': 'db',
    });
    const plain = await planSnapshot(directory.path, rules(['**']));
    assert.deepEqual(plain.entries.map((entry) => entry.relativePath), ['index.js']);
    assert.ok(plain.skipped.some((entry) => entry.relativePath === 'node_modules' && entry.reason === 'default-excluded'));

    const allowed = await planSnapshot(directory.path, rules(['**'], { allowDefaultExcluded: ['node_modules/terser/**'] }));
    assert.deepEqual(allowed.entries.map((entry) => entry.relativePath), ['index.js', 'node_modules/terser/index.js']);
  } finally {
    directory.cleanup();
  }
});

test('symlinks are sent as links only when they stay inside the root, and are never followed', async () => {
  const directory = temporaryDirectory();
  try {
    const root = join(directory.path, 'root');
    const privateData = join(directory.path, 'private');
    writeFiles(privateData, { 'secret.txt': 'do not send' });
    writeFiles(root, { 'lib/real.txt': 'real' });
    symlinkSync('real.txt', join(root, 'lib/inside-link'));
    symlinkSync('../../private/secret.txt', join(root, 'lib/escape-link'));
    symlinkSync(join(privateData, 'secret.txt'), join(root, 'lib/absolute-link'));
    symlinkSync(privateData, join(root, 'linked-dir'));
    const plan = await planSnapshot(root, rules(['**']));
    assert.deepEqual(plan.entries.map((entry) => `${entry.kind}:${entry.relativePath}`).sort(), ['file:lib/real.txt', 'symlink:lib/inside-link']);
    const reasons = Object.fromEntries(plan.skipped.map((entry) => [entry.relativePath, entry.reason]));
    assert.equal(reasons['lib/escape-link'], 'symlink-outside-root');
    assert.equal(reasons['lib/absolute-link'], 'symlink-absolute');
    // The symlinked directory is a link outside the root: skipped, never descended.
    assert.equal(reasons['linked-dir'], 'symlink-absolute');
    assert.ok(!plan.manifestText.includes('secret'));
  } finally {
    directory.cleanup();
  }
});

test('checkSymlinkTarget resolves relative to the link location', () => {
  assert.equal(checkSymlinkTarget('a/b/link', '../c'), undefined);
  assert.equal(checkSymlinkTarget('a/link', '../../outside'), 'symlink-outside-root');
  assert.equal(checkSymlinkTarget('link', '/etc/passwd'), 'symlink-absolute');
});

test('the digest covers content and modes, and changes with any edit', async () => {
  const directory = temporaryDirectory();
  try {
    writeFiles(directory.path, { 'a.txt': 'one', 'tools/run.sh': '#!/bin/sh\n' });
    const first = await planSnapshot(directory.path, rules(['**']));
    const again = await planSnapshot(directory.path, rules(['**']));
    assert.equal(first.digest, again.digest);
    writeFileSync(join(directory.path, 'a.txt'), 'two');
    const edited = await planSnapshot(directory.path, rules(['**']));
    assert.notEqual(edited.digest, first.digest);
    execFileSync('chmod', ['+x', join(directory.path, 'tools/run.sh')]);
    const modeChanged = await planSnapshot(directory.path, rules(['**']));
    assert.notEqual(modeChanged.digest, edited.digest);
  } finally {
    directory.cleanup();
  }
});

test('size limits stop oversized inputs before anything is sent', async () => {
  const directory = temporaryDirectory();
  try {
    writeFiles(directory.path, { 'big.bin': 'x'.repeat(2 * 1024 * 1024) });
    await assert.rejects(planSnapshot(directory.path, rules(['**'], { maxFileMiB: 1 })), /limit 1 MiB/);
    await assert.rejects(planSnapshot(directory.path, rules(['**'], { maxTotalMiB: 1, maxFileMiB: 4 })), /exceeds 1 MiB/);
  } finally {
    directory.cleanup();
  }
});

test('names with control characters are skipped, unmatched includes reported', async () => {
  const directory = temporaryDirectory();
  try {
    mkdirSync(join(directory.path, 'src'));
    writeFileSync(join(directory.path, 'src', 'bad\nname.txt'), 'x');
    writeFileSync(join(directory.path, 'src', 'good.txt'), 'x');
    const plan = await planSnapshot(directory.path, rules(['src/**', 'missing/**']));
    assert.deepEqual(plan.entries.map((entry) => entry.relativePath), ['src/good.txt']);
    assert.ok(plan.skipped.some((entry) => entry.reason === 'unsafe-name'));
    assert.deepEqual(plan.unmatchedIncludes, ['missing/**']);
  } finally {
    directory.cleanup();
  }
});

test('a dirty Git tree is sent as on disk and its index is left untouched', async () => {
  const directory = temporaryDirectory();
  try {
    const git = (...args: string[]): string => execFileSync('git', ['-C', directory.path, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).toString();
    git('init', '-q');
    writeFiles(directory.path, { 'committed.txt': 'v1', 'staged.txt': 'v1' });
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    writeFileSync(join(directory.path, 'staged.txt'), 'v2-staged');
    git('add', 'staged.txt');
    writeFileSync(join(directory.path, 'staged.txt'), 'v3-unstaged-on-top');
    writeFileSync(join(directory.path, 'committed.txt'), 'v2-unstaged');
    writeFileSync(join(directory.path, 'untracked.txt'), 'new');
    const statusBefore = git('status', '--porcelain=v1');
    const indexBefore = git('ls-files', '--stage');

    const plan = await planSnapshot(directory.path, rules(['*.txt']));
    const state = await readGitState(directory.path);
    assert.deepEqual(plan.entries.map((entry) => entry.relativePath), ['committed.txt', 'staged.txt', 'untracked.txt']);
    assert.equal(state?.staged, 1);
    assert.equal(state?.unstaged, 2);
    assert.equal(state?.untracked, 1);
    assert.equal(git('status', '--porcelain=v1'), statusBefore);
    assert.equal(git('ls-files', '--stage'), indexBefore);
  } finally {
    directory.cleanup();
  }
});
