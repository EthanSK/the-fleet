// All command-line and Agent Bridge clients contact the same local coordinator.
// The old fleet-runner name delegates here too; it never bypasses admission.
import { request } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { ensurePrivateDir, expandHome, resolveStatePaths, type StatePaths } from '../paths.ts';
import { HELP } from '../cli/main.ts';
import { expectPositionals, isHelpRequest, parseArgs, single } from '../cli/args.ts';
import { usageError } from '../errors.ts';

export function callApi(paths: StatePaths, method: string, path: string, value?: unknown, timeout = 120_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: join(paths.home, 'service.sock'), method, path,
      headers: { 'content-type': 'application/json', connection: 'close' } }, (res) => {
      const buffers: Buffer[] = []; let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) { res.destroy(new Error('API response exceeds 4 MiB.')); return; }
        buffers.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const result: unknown = JSON.parse(Buffer.concat(buffers).toString());
          if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid API response.');
          const data = result as Record<string, unknown>;
          if ((res.statusCode ?? 500) >= 400) throw Object.assign(new Error(String(data['error'] ?? 'API request failed')), { exitCode: data['exitCode'] });
          resolve(data);
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('The Fleet API timed out.')));
    req.end(value === undefined ? undefined : JSON.stringify(value));
  });
}

const bin = fileURLToPath(new URL('../../bin/the-fleet.js', import.meta.url));
const lockProgram = fileURLToPath(new URL('../../bin/service-lock.py', import.meta.url));
async function health(paths: StatePaths): Promise<boolean> {
  let data: Record<string, unknown>;
  try { data = await callApi(paths, 'GET', '/v1/health', undefined, 500); }
  catch (error) {
    if (error instanceof Error && ['ENOENT', 'ECONNREFUSED'].includes(String((error as NodeJS.ErrnoException).code))) return false;
    throw error;
  }
  if (data['application'] !== 'The Fleet' || data['protocolVersion'] !== 1) throw new Error('Another or incompatible service owns The Fleet socket.');
  return true;
}

export async function ensureService(paths: StatePaths): Promise<StatePaths> {
  if (await health(paths)) return paths;
  // The lock owner opens the log after resolving migrations, so a racing CLI
  // cannot recreate the retired home before it acquires the parent guard.
  const child = spawn('python3', [lockProgram, '--log', process.execPath, bin, 'service', 'serve'], {
    detached: true, stdio: 'ignore', env: { ...process.env, THE_FLEET_HOME: paths.home },
  });
  let spawnError: Error | undefined;
  child.on('error', (error) => { spawnError = error; }); child.unref();
  for (let i = 0; i < 100; i++) {
    await new Promise((done) => setTimeout(done, 100));
    if (spawnError) throw spawnError;
    paths = resolveStatePaths({ ...process.env, THE_FLEET_HOME: paths.home });
    if (await health(paths)) return paths;
  }
  throw new Error(`The Fleet did not start. Inspect ${join(paths.home, 'service.log')}.`);
}

async function follow(paths: StatePaths, id: string): Promise<number> {
  let offset = 0;
  let interrupts = 0;
  const cancel = () => { interrupts += 1; void callApi(paths, 'POST', `/v1/operations/${id}/cancel`,
    interrupts > 1 ? { forceDisconnect: true } : {}).catch(() => {}); };
  process.on('SIGINT', cancel);
  try {
    for (;;) {
      const state = await callApi(paths, 'GET', `/v1/operations/${id}?offset=${offset}`);
      if (state['truncated']) process.stderr.write('[Earlier output omitted; full output is in the job receipt.]\n');
      if (typeof state['output'] === 'string') process.stdout.write(state['output']);
      offset = Number(state['nextOffset']);
      if (state['status'] === 'complete') return Number(state['exitCode']);
      await new Promise((done) => setTimeout(done, 250));
    }
  } finally { process.removeListener('SIGINT', cancel); }
}

function argument(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1];
}
const print = (data: unknown) => process.stdout.write(JSON.stringify(data, null, 2) + '\n');
function xml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }

function submitArguments(argv: readonly string[]): { requestFile: string; dryRun: boolean; machine?: string; machines?: readonly string[]; owner?: string } {
  // Pinning a worker must never silently become default worker selection.
  const args = parseArgs(argv, { flags: ['dry-run'], values: ['machine', 'machines', 'owner'] });
  const [requestFile = ''] = expectPositionals(args, ['request'], 'the-fleet submit <request.json | -> [--machine <name> | --machines <name,...>]');
  if (args.passthrough.length) throw usageError('Put job arguments in the request JSON.');
  const machine = single(args, 'machine');
  const workerList = single(args, 'machines');
  const owner = single(args, 'owner');
  if (machine !== undefined && workerList !== undefined) throw usageError('Choose one worker selector: --machine or --machines.');
  if (machine !== undefined && (!machine || machine.includes(','))) throw usageError('--machine needs one worker. Use --machines for a list.');
  const machines = workerList === undefined ? machine === undefined ? undefined : [machine] : workerList.split(',');
  if (machines?.some((name) => !name)) throw usageError('--machines needs a comma-separated list of workers.');
  const dryRun = args.flags.has('dry-run');
  if (dryRun && workerList !== undefined) throw usageError('Use --machine with --dry-run.');
  return { requestFile, dryRun, ...(machine === undefined ? {} : { machine }), ...(machines === undefined ? {} : { machines }), ...(owner === undefined ? {} : { owner }) };
}

function projectResolutionArguments(argv: readonly string[]): { source: string; manifestPath?: string } {
  const args = parseArgs(argv, { flags: [], values: ['source', 'manifest'] });
  expectPositionals(args, [], 'the-fleet project resolve [--source <dir>] [--manifest <file>]');
  if (args.passthrough.length) throw usageError('Project resolution does not accept arguments after --.');
  const source = single(args, 'source') ?? process.cwd();
  const manifest = single(args, 'manifest');
  return { source: resolve(expandHome(source)), ...(manifest === undefined ? {} : { manifestPath: resolve(expandHome(manifest)) }) };
}

export async function runClient(argv: readonly string[]): Promise<number> {
  if (isHelpRequest(argv)) { process.stdout.write(HELP); return 0; }
  if (argv[0] === 'migrate-home') {
    const args = parseArgs(argv.slice(1), { flags: ['dry-run'], values: [] });
    expectPositionals(args, [], 'the-fleet migrate-home [--dry-run]');
    if (args.passthrough.length) throw usageError('Unexpected migration arguments.');
    // This command moves the default home only. A custom controller must not
    // accidentally migrate a different installation in the user's home.
    const configuredHome = process.env['THE_FLEET_HOME'] ?? process.env['FLEET_RUNNER_HOME'];
    if (configuredHome && !['.fleet-runner', '.the-fleet'].some(name => resolve(expandHome(configuredHome)) === join(homedir(), name))) {
      throw usageError('migrate-home applies only to the default state folder. Clear the custom home override before migrating it.');
    }
    const migration = fileURLToPath(new URL('../../bin/migrate-state.py', import.meta.url));
    const result = spawnSync('python3', ['-B', migration, ...(args.flags.has('dry-run') ? ['--dry-run'] : [])], { stdio: 'inherit' });
    if (result.error) throw result.error;
    return result.status ?? 2;
  }
  let paths = resolveStatePaths();
  if (argv[0] === '--version') { print({ application: 'The Fleet', version: JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version }); return 0; }
  const submitted = argv[0] === 'submit' ? submitArguments(argv.slice(1)) : undefined;
  const projectResolution = argv[0] === 'project' && argv[1] === 'resolve'
    ? projectResolutionArguments(argv.slice(2)) : undefined;
  if (argv[0] === 'service' && argv[1] === 'serve') { await (await import('./server.ts')).serve(paths); return 0; }
  if (argv[0] === 'service' && argv[1] === 'install') {
    if (process.platform !== 'darwin') throw new Error('Use your service manager to run bin/service-lock.py node bin/the-fleet.js service serve.');
    const directory = join(homedir(), 'Library', 'LaunchAgents'); mkdirSync(directory, { recursive: true }); ensurePrivateDir(paths.home);
    const plist = join(directory, 'org.the-fleet.service.plist');
    const args = ['python3', lockProgram, process.execPath, bin, 'service', 'serve'];
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>org.the-fleet.service</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join('')}</array><key>EnvironmentVariables</key><dict><key>THE_FLEET_HOME</key><string>${xml(paths.home)}</string><key>PATH</key><string>${xml(process.env['PATH'] ?? '/usr/bin:/bin')}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(join(paths.home, 'service.log'))}</string><key>StandardErrorPath</key><string>${xml(join(paths.home, 'service.log'))}</string></dict></plist>\n`, { mode: 0o600 });
    print({ installed: plist, load: `launchctl bootstrap gui/$(id -u) '${plist}'` }); return 0;
  }
  paths = await ensureService(paths);
  if (projectResolution) {
    print(await callApi(paths, 'POST', '/v1/projects/resolve', projectResolution));
    return 0;
  }
  const owner = submitted?.owner ?? argument(argv, '--owner') ?? process.env['CODEX_THREAD_ID'] ?? `cli-${process.pid}`;
  if (argv[0] === 'state') { print(await callApi(paths, 'GET', `/v1/state${argv.includes('--fresh') ? '?fresh=1' : ''}`)); return 0; }
  if (argv[0] === 'maintain') {
    print(await callApi(paths, 'POST', '/v1/maintenance', { machine: argument(argv, '--machine') }, 360_000)); return 0;
  }
  if (argv[0] === 'service') { print(await callApi(paths, argv[1] === 'stop' ? 'POST' : 'GET', argv[1] === 'stop' ? '/v1/stop' : '/v1/health', argv[1] === 'stop' ? {} : undefined)); return 0; }
  if (argv[0] === 'reserve') {
    print(await callApi(paths, 'POST', '/v1/reservations', { owner, label: argument(argv, '--label') ?? 'External SSH work', machines: argument(argv, '--machines')?.split(','), ttlSeconds: Number(argument(argv, '--ttl') ?? 180), claim: { mode: argv.includes('--drain') ? 'drain' : argv.includes('--shared') ? 'shared' : 'exclusive', resources: argument(argv, '--resources')?.split(',') ?? [] } })); return 0;
  }
  if (argv[0] === 'renew' || argv[0] === 'release' || argv[0] === 'activate') { print(await callApi(paths, 'POST', `/v1/${argv[0]}`, { id: argument(argv, '--id'), token: argument(argv, '--token'), ttlSeconds: Number(argument(argv, '--ttl') ?? 180), workStopped: argv.includes('--work-stopped') })); return 0; }
  if (argv[0] === 'recover-reservations') { print(await callApi(paths, 'POST', '/v1/recover', {})); return 0; }
  if (argv[0] === 'rpc') {
    const input = argv[3] ? JSON.parse(readFileSync(argv[3] === '-' ? 0 : argv[3], 'utf8')) : undefined;
    print(await callApi(paths, argv[1] ?? 'GET', argv[2] ?? '/v1/health', input)); return 0;
  }
  if (submitted?.dryRun) {
    print(await callApi(paths, 'POST', '/v1/submit/plan', { cwd: process.cwd(),
      request: JSON.parse(readFileSync(submitted.requestFile === '-' ? 0 : submitted.requestFile, 'utf8')), machine: submitted.machine })); return 0;
  }
  const response = await callApi(paths, 'POST', submitted ? '/v1/submit' : '/v1/command', {
    owner, cwd: process.cwd(), runsDirectory: process.env['THE_FLEET_RUNS_DIRECTORY'] ?? process.env['FLEET_RUNNER_RUNS_DIRECTORY'],
    ...(submitted ? { request: JSON.parse(readFileSync(submitted.requestFile === '-' ? 0 : submitted.requestFile, 'utf8')), machines: submitted.machines } : { argv }),
  });
  return follow(paths, String(response['operationId']));
}
