// Transport quoting and Agent Bridge route resolution.
//
// The quoting tests run real sh, bash and zsh: each quoted word must arrive
// as exactly one argument with identical bytes.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { resolveAgentBridgeRoute, parseAgentBridgeConfig } from '../src/transport/agentBridgeConfig.ts';
import { inlineBashCommand, remotePathWord, shellJoin, shellQuote } from '../src/transport/shellQuote.ts';
import { sshArguments } from '../src/transport/sshTransport.ts';

const TRICKY = [
  'plain',
  'with space',
  "it's",
  '"double"',
  '$HOME',
  '`whoami`',
  '$(rm -rf /)',
  'a;b&&c|d',
  'line\nbreak',
  '-rf',
  '--delete',
  '=ls',
  '~',
  '~/x',
  '*.swift',
  '{a,b}',
  'tab\there',
  'ünïcødé ✓',
  '',
  "'",
  '\\',
  '!history',
];

for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh']) {
  test(`shellQuote round-trips every value through ${shell}`, { skip: !existsSync(shell) }, () => {
    const output = execFileSync(shell, ['-c', `printf '%s\\0' ${shellJoin(TRICKY)}`], { env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } });
    const received = output.toString('utf8').split('\0').slice(0, -1);
    assert.deepEqual(received, TRICKY);
  });
}

test('shellQuote refuses NUL bytes', () => {
  assert.throws(() => shellQuote('a\0b'));
});

test('remotePathWord expands only a leading ~/ to the remote $HOME', () => {
  const output = execFileSync('/bin/sh', ['-c', `printf '%s' ${remotePathWord('~/Fleet Runner.noindex')}`], { env: { HOME: '/remote/home' } });
  assert.equal(output.toString(), '/remote/home/Fleet Runner.noindex');
  assert.equal(remotePathWord('/abs/$HOME'), "'/abs/$HOME'");
});

test('inline bash commands pass positional arguments exactly', () => {
  const command = inlineBashCommand('printf "%s|" "$@"', 'name', ['one', shellQuote('two words'), shellQuote("it's")]);
  assert.equal(execFileSync('/bin/zsh', ['-c', command]).toString(), "one|two words|it's|");
});

const CONFIG = `[Mac-Mini]
host=mini.local
user=ethan
port=22
key=~/.agent-bridge/keys/Mac-Mini
identity_file=/Users/me/.agent-bridge/keys/Mac-Mini
internet_host=100.64.0.5
internet_port=2222
paired_at=2026-04-09T12:00:00

[Lan-Only]
host=lan.local
user=ethan
port=22
key=/keys/lan

[Evil]
host=-oProxyCommand=sh
user=ethan
`;

test('the Tailscale endpoint is used when configured, with no LAN fallback', () => {
  const route = resolveAgentBridgeRoute('mac-mini', CONFIG);
  assert.equal(route.host, '100.64.0.5');
  assert.equal(route.port, 2222);
  assert.equal(route.path, 'internet');
  assert.equal(route.identityFile, '/Users/me/.agent-bridge/keys/Mac-Mini');
});

test('the LAN host and legacy key field are used when no internet host exists', () => {
  const route = resolveAgentBridgeRoute('Lan-Only', CONFIG);
  assert.equal(route.host, 'lan.local');
  assert.equal(route.path, 'lan');
  assert.equal(route.identityFile, '/keys/lan');
});

test('config values cannot inject ssh options, and errors do not echo them', () => {
  assert.throws(() => resolveAgentBridgeRoute('Evil', CONFIG), (error: unknown) => error instanceof Error && !error.message.includes('ProxyCommand'));
  assert.throws(() => resolveAgentBridgeRoute('Missing', CONFIG), /no paired target "Missing"/);
});

test('ssh arguments reuse pairing and retain verified host identities', () => {
  const args = sshArguments(resolveAgentBridgeRoute('Mac-Mini', CONFIG));
  assert.deepEqual(args.slice(-1), ['ethan@100.64.0.5']);
  for (const option of ['StrictHostKeyChecking=accept-new', 'BatchMode=yes', 'IdentitiesOnly=yes']) assert.ok(args.includes(option), option);
  assert.ok(!args.includes('UserKnownHostsFile=/dev/null'));
  assert.ok(args.includes('-T'));
  assert.ok(args.includes('-C'));
});

test('section names match case-insensitively, first section wins', () => {
  const sections = parseAgentBridgeConfig('[A]\nhost=one\n[a]\nhost=two\n');
  assert.equal(sections.get('a')?.values.get('host'), 'one');
});
