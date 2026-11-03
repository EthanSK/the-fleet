// Glob semantics for sync patterns and the built-in exclusion rules.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileGlob, couldMatchWithin, coversDirectory, matchesPathOrAncestor, type CompiledGlob } from '../src/snapshot/glob.ts';
import { matchExclusionRules } from '../src/snapshot/rules.ts';

function glob(pattern: string): CompiledGlob {
  const result = compileGlob(pattern);
  assert.ok(result.ok, `pattern ${pattern} should compile`);
  return result.glob;
}

test('patterns are anchored at the source root', () => {
  assert.ok(glob('*.swift').regex.test('Package.swift'));
  assert.ok(!glob('*.swift').regex.test('Sources/App.swift'));
  assert.ok(glob('**/*.swift').regex.test('Sources/App/App.swift'));
  assert.ok(glob('**/*.swift').regex.test('Top.swift'));
});

test('a directory pattern covers its subtree', () => {
  assert.ok(matchesPathOrAncestor([glob('Sources')], 'Sources/App/main.swift'));
  assert.ok(matchesPathOrAncestor([glob('Sources/**')], 'Sources/App/main.swift'));
  assert.ok(!matchesPathOrAncestor([glob('Sources')], 'SourcesExtra/x.swift'));
});

test('braces, ? and dotfiles', () => {
  assert.ok(glob('Tests/**/*.{swift,json}').regex.test('Tests/A/fixture.json'));
  assert.ok(glob('file?.txt').regex.test('file1.txt'));
  assert.ok(glob('*').regex.test('.hidden'));
});

test('invalid patterns are rejected', () => {
  assert.equal(compileGlob('../x').ok, false);
  assert.equal(compileGlob('/abs/**').ok, false);
  assert.equal(compileGlob('a/**b').ok, false);
  assert.equal(compileGlob('[ab]').ok, false);
  assert.equal(compileGlob('-rf').ok, false);
});

test('couldMatchWithin decides which directories to walk', () => {
  assert.ok(couldMatchWithin(glob('Sources/**/*.swift'), 'Sources'));
  assert.ok(couldMatchWithin(glob('Sources/**/*.swift'), 'Sources/A/B'));
  assert.ok(!couldMatchWithin(glob('Sources/**/*.swift'), 'docs'));
  assert.ok(couldMatchWithin(glob('**/*.swift'), 'anything/deep'));
  assert.ok(couldMatchWithin(glob('node_modules/terser/**'), 'node_modules'));
  assert.ok(!couldMatchWithin(glob('node_modules/terser/**'), 'node_modules/acorn'));
});

test('coversDirectory prunes whole excluded folders only', () => {
  assert.ok(coversDirectory(glob('fixtures/**'), 'fixtures'));
  assert.ok(coversDirectory(glob('**/build/**'), 'a/build'));
  assert.ok(!coversDirectory(glob('fixtures/**/*.log'), 'fixtures'));
});

test('safety rules block credentials and VCS data at any depth', () => {
  for (const path of ['.env', 'config/.env.production', '.git/config', 'a/.ssh/id_ed25519', 'keys/server.pem', 'Profile/Login Data', '.npmrc']) {
    assert.equal(matchExclusionRules(path, 'file')?.tier, 'safety', path);
  }
  assert.equal(matchExclusionRules('.env.example', 'file'), undefined);
  assert.equal(matchExclusionRules('.git', 'directory')?.tier, 'safety');
});

test('default rules skip bulky local output', () => {
  assert.equal(matchExclusionRules('node_modules/x/index.js', 'file')?.tier, 'default');
  assert.equal(matchExclusionRules('build.noindex/App.app/Contents/Info.plist', 'file')?.tier, 'default');
  assert.equal(matchExclusionRules('data/live.sqlite', 'file')?.tier, 'default');
  assert.equal(matchExclusionRules('Sources/App/main.swift', 'file'), undefined);
});
