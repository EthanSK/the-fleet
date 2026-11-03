#!/usr/bin/env node
// The Fleet CLI is a client of the per-user coordinator, not a second runner.
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  process.stderr.write('The Fleet requires Node 22.18 or newer.\n'); process.exit(2);
}
try {
  process.exitCode = await (await import('../src/service/client.ts')).runClient(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`The Fleet: ${error.message}\n`); process.exitCode = typeof error.exitCode === 'number' ? error.exitCode : 2;
}
