// Exercise the exact remote supervisor in isolated local homes, including
// process cleanup and contention. Live Mini qualification is separate.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Transform, Writable } from 'node:stream';
import { registerProject, loadProject } from '../src/registry.ts';
import { Interrupts, runProfile } from '../src/run/runJob.ts';
import { runControl, fetchStatus } from '../src/run/remoteChecks.ts';
import { supervisorCommand, uploadCommand } from '../src/remote/remoteScripts.ts';
import { tarStream } from '../src/snapshot/tar.ts';
import { JobSession } from '../src/run/jobSession.ts';
import { recoverArtifacts } from '../src/run/recoverArtifacts.ts';
import { execFileSync } from 'node:child_process';
import { shellQuote } from '../src/transport/shellQuote.ts';
import type { RemoteProcess } from '../src/transport/transport.ts';
import { testEnvironment, testMachine, writeFiles, waitUntil } from './helpers/fixtures.ts';

function setup(command: string, extra: Record<string, unknown> = {}) {
  const env = testEnvironment();
  const source = join(env.root, 'source');
  writeFiles(source, { 'run.sh': command });
  const manifest = join(env.root, 'project.json');
  writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, id: 'fixture', sourceRoot: source,
    sync: { include: ['run.sh'] }, profiles: { test: { description: 'fixture', kind: 'test', argv: ['bash', 'run.sh'], timeoutMinutes: 0.2,
      success: { minTestCount: { pattern: 'tests ([0-9]+)', min: 1 } }, ...extra } } }));
  registerProject(env.paths, manifest, undefined, false);
  const machine = testMachine();
  const interrupts = new Interrupts();
  const request = { paths: env.paths, project: loadProject(env.paths, 'fixture'), profileName: 'test', machine, transport: env.transport,
    sourceRoot: source, extraArgs: [], ignoreHeavyProcesses: false, interrupts,
    io: { stdout: env.stdout, stderr: env.stderr, status: (_line: string) => {} } };
  return { env, request, interrupts };
}

test('real supervisor returns verified artifacts, stderr and cleanup', { timeout: 30000 }, async () => {
  const { env, request } = setup('echo tests 3; echo diagnostic >&2; echo result > result.txt', { artifacts: ['result.txt'] });
  try {
    const run = await runProfile(request);
    assert.equal(run.receipt.outcome, 'passed', JSON.stringify(run.receipt));
    assert.equal(run.receipt.success.testCount, 3);
    assert.match(env.stderr.text, /diagnostic/);
    assert.equal(run.receipt.artifacts.length, 1);
    assert.equal(readFileSync(join(run.receiptPath, '..', 'artifacts', 'result.txt'), 'utf8'), 'result\n');
    assert.equal(existsSync(join(env.remoteRoot, 'locks', 'heavy')), false);
    assert.equal(existsSync(join(env.remoteRoot, 'jobs', run.receipt.jobId, 'src')), false);
  } finally { env.cleanup(); }
});

test('real supervisor returns bounded process-group resource measurements without retaining source', { timeout: 30000 }, async () => {
  const { env, request } = setup('python3 -c "import time; data=bytearray(32*1024*1024); time.sleep(6)"; echo tests 1');
  try {
    const run = await runProfile(request);
    assert.equal(run.receipt.outcome, 'passed', JSON.stringify(run.receipt));
    assert.ok(run.receipt.resources);
    assert.ok(run.receipt.resources.sampleCount > 0);
    assert.ok(run.receipt.resources.peakRssKiB >= 32 * 1024);
    assert.ok(run.receipt.resources.peakProcessCpuPercent >= 0);
    assert.equal(run.receipt.resources.sampleIntervalSeconds, 5);
    assert.equal(run.receipt.remote.lockReleased, true);
    assert.equal(existsSync(join(env.remoteRoot, 'jobs', run.receipt.jobId, 'src')), false);
  } finally { env.cleanup(); }
});

for (const [name, command] of [['nonzero', 'echo tests 2; exit 7'], ['zero tests', 'echo tests 0']] as const) {
  test(`real supervisor rejects ${name}`, { timeout: 30000 }, async () => {
    const { env, request } = setup(command);
    try { const run = await runProfile(request); assert.equal(run.receipt.outcome, 'failed'); assert.equal(run.receipt.remote.lockReleased, true); }
    finally { env.cleanup(); }
  });
}

test('profile inputs compose with base inputs and preserve credential exclusions', { timeout: 30000 }, async () => {
  const { env, request } = setup('test "$(cat fixture/required.txt)" = expected && test ! -e fixture/.env && echo tests 1', { extraInputs: ['fixture/**'] });
  writeFiles(request.sourceRoot, { 'fixture/required.txt': 'expected', 'fixture/.env': 'synthetic-secret' });
  try {
    const run = await runProfile(request);
    assert.equal(run.receipt.outcome, 'passed', JSON.stringify(run.receipt));
    assert.equal(run.receipt.remote.lockReleased, true);
  } finally { env.cleanup(); }
});

test('timeout stops a TERM-resistant process group', { timeout: 30000 }, async () => {
  const { env, request } = setup("trap '' TERM; sleep 20 & echo CHILD=$!; wait; echo tests 1", { timeoutMinutes: 0.05 });
  try {
    const run = await runProfile(request);
    assert.equal(run.receipt.outcome, 'timed-out');
    assert.equal(run.receipt.remote.processesRemaining, false);
    assert.equal(run.receipt.remote.lockReleased, true);
    const pid = Number(/CHILD=(\d+)/.exec(env.stdout.text)?.[1]);
    assert.ok(pid > 0);
    assert.throws(() => process.kill(pid, 0));
  } finally { env.cleanup(); }
});

test('interrupt cancels the remote job and cleans its scratch', { timeout: 30000 }, async () => {
  const { env, request, interrupts } = setup('echo RUNNING; sleep 20; echo tests 1');
  try {
    const pending = runProfile(request);
    assert.equal(await waitUntil(() => env.stdout.text.includes('RUNNING'), 10000), true);
    interrupts.trigger();
    const run = await pending;
    assert.equal(run.receipt.outcome, 'cancelled');
    assert.equal(run.receipt.remote.lockReleased, true);
  } finally { env.cleanup(); }
});

test('kernel admission guard refuses concurrent stale clears and supervisors', { timeout: 30000 }, async () => {
  const env = testEnvironment();
  const machine = testMachine();
  const one = new JobSession(env.transport, supervisorCommand(machine, { jobId: 'first', nonce: 'abc', timeoutSeconds: 5, label: 'fixture/test' }), 'abc', { onJobStdout: () => {}, onStderr: () => {} });
  try {
    await one.waitFor(['READY'], 10000);
    const clear = await runControl(env.transport, machine, 'clear-stale');
    assert.equal(clear.result, 'busy');
    const two = new JobSession(env.transport, supervisorCommand(machine, { jobId: 'second', nonce: 'def', timeoutSeconds: 5, label: 'fixture/test' }), 'def', { onJobStdout: () => {}, onStderr: () => {} });
    assert.equal((await two.waitFor(['BUSY'], 10000)).word, 'BUSY');
    two.closeInput(); await two.exited;
    assert.match(readFileSync(join(env.remoteRoot, 'locks', 'heavy', 'owner'), 'utf8'), /job_id=first/);
    one.send('ABORT'); await one.waitFor(['BYE'], 10000); one.closeInput(); await one.exited;
    // Simulate an old owner after the kernel guard has been released.
    mkdirSync(join(env.remoteRoot, 'locks', 'heavy'));
    const staleJob = join(env.remoteRoot, 'jobs', 'old');
    writeFiles(staleJob, { '.fleet-job': '', 'derived.noindex/file': 'scratch', 'stdout.log': 'evidence' });
    writeFileSync(join(env.remoteRoot, 'locks', 'heavy', 'owner'), `job_id=old\nsupervisor_pid=99999999\njob_dir=${staleJob}\n`);
    const clears = await Promise.all([runControl(env.transport, machine, 'clear-stale'), runControl(env.transport, machine, 'clear-stale')]);
    assert.ok(clears.some((item) => item.result === 'cleared'));
    assert.equal(existsSync(join(env.remoteRoot, 'locks', 'heavy')), false);
    assert.equal(existsSync(join(staleJob, 'derived.noindex')), false);
    assert.equal(readFileSync(join(staleJob, 'stdout.log'), 'utf8'), 'evidence');
  } finally { one.closeInput(); await one.exited; env.cleanup(); }
});

test('rejected artifact cannot be counted as returned', { timeout: 30000 }, async () => {
  const { env, request } = setup('ln -s /etc/hosts result.txt; echo tests 1', { artifacts: ['result.txt'] });
  try {
    const run = await runProfile(request);
    assert.equal(run.receipt.outcome, 'failed');
    assert.ok(run.receipt.missingArtifacts.includes('result.txt'));
  } finally { env.cleanup(); }
});

test('oversized sparse artifacts retain their only source copy and ownership before transfer', { timeout: 30000 }, async () => {
  const { env, request } = setup("python3 -c \"with open('sparse.bin','wb') as f: f.truncate(2*1024*1024)\"; echo tests 1", { artifacts: ['sparse.bin'], maxArtifactMiB: 1 });
  try {
    const run = await runProfile(request);
    assert.equal(run.receipt.outcome, 'error');
    assert.ok(run.receipt.remote.notes.some((note) => note.includes('exceed')));
    assert.equal(existsSync(join(run.receiptPath, '..', 'artifacts.tar.part')), false);
    const directory = join(env.remoteRoot, 'jobs', run.receipt.jobId);
    assert.equal(existsSync(join(directory, 'src/sparse.bin')), true);
    assert.equal(run.receipt.remote.lockReleased, false);
    assert.equal((await runControl(env.transport, testMachine(), 'clear-stale')).result, 'artifact-capture-failed');
    assert.equal(existsSync(join(directory, 'src/sparse.bin')), true);
  } finally { env.cleanup(); }
});

test('oversized ordinary reports recover after an inspected budget increase without replaying the command', { timeout: 30000 }, async () => {
  const { env, request } = setup("python3 -c \"open('report.txt','wb').write(b'x'*(2*1024*1024))\"; echo tests 1; exit 7", { artifacts: ['report.txt'], maxArtifactMiB: 1 });
  try {
    const run = await runProfile(request);
    const directory = join(env.remoteRoot, 'jobs', run.receipt.jobId);
    const originalResult = readFileSync(join(directory, 'result'), 'utf8');
    assert.equal(run.receipt.outcome, 'error');
    assert.equal(run.receipt.remote.exitCode, 7);
    assert.equal(readFileSync(join(directory, 'src/report.txt')).length, 2 * 1024 * 1024);
    writeFileSync(join(directory, 'meta/max-artifact-kb'), '4096\n');
    assert.equal((await runControl(env.transport, testMachine(), 'clear-stale')).result, 'cleared');
    const recovered = await recoverArtifacts(env.paths, env.transport, testMachine(), run.receipt.jobId);
    assert.equal(readFileSync(join(recovered, 'report.txt')).equals(Buffer.alloc(2 * 1024 * 1024, 'x')), true);
    assert.equal(readFileSync(join(directory, 'result'), 'utf8'), originalResult);
    assert.equal(JSON.parse(readFileSync(run.receiptPath, 'utf8')).outcome, 'error');
  } finally { env.cleanup(); }
});


test('lost cleanup confirmation cannot produce a passed receipt', { timeout: 30000 }, async () => {
  const { env, request } = setup('echo tests 1');
  const transport = {
    description: env.transport.description,
    isConnectionFailure: () => false,
    start: (command: string) => {
      const remote = env.transport.start(command);
      if (!command.includes('fleet-runner-supervisor')) return remote;
      let pending = '';
      const filtered = new Transform({ transform(chunk, _encoding, done) {
        pending += chunk.toString();
        for (;;) {
          const newline = pending.indexOf('\n');
          if (newline < 0) break;
          const line = pending.slice(0, newline + 1);
          pending = pending.slice(newline + 1);
          if (!line.startsWith('@@FR RELEASED') && !line.startsWith('@@FR BYE')) this.push(line);
        }
        done();
      }});
      remote.stdout.pipe(filtered);
      return { ...remote, stdout: filtered };
    },
  };
  try {
    const run = await runProfile({ ...request, transport });
    assert.equal(run.receipt.outcome, 'error');
    assert.notEqual(run.exitCode, 0);
  } finally { env.cleanup(); }
});

/** Edits the source once the tar upload session starts; the stream reads files lazily after that. */
function editDuringUpload(source: string, start: (command: string) => RemoteProcess): (command: string) => RemoteProcess {
  const uploadPrefix = uploadCommand('/fixture').replace(/ [^ ]+$/, ' ');
  return (command) => {
    if (command.startsWith(uploadPrefix)) writeFileSync(join(source, 'run.sh'), 'echo edited; echo tests 1');
    return start(command);
  };
}

test('a source change during tar upload aborts before the job without an error', { timeout: 30000 }, async () => {
  const { env, request } = setup('echo COMMAND_STARTED; echo tests 1');
  const transport = { description: env.transport.description, isConnectionFailure: () => false,
    start: editDuringUpload(request.sourceRoot, (command) => env.transport.start(command)) };
  try {
    const run = await runProfile({ ...request, transport });
    assert.equal(run.receipt.outcome, 'aborted', JSON.stringify(run.receipt));
    assert.deepEqual(run.receipt.abort, { reason: 'source-changed', path: 'run.sh' });
    assert.equal(run.exitCode, 2, 'exit code unchanged from when this was recorded as error');
    assert.equal(run.receipt.summary, 'run.sh changed after planning. Run again once edits settle.');
    assert.equal(run.receipt.timing.remoteStartedAt, null);
    assert.equal(run.receipt.remote.lockReleased, true);
    assert.equal(run.receipt.remote.processesRemaining, false);
    assert.equal(env.stdout.text.includes('COMMAND_STARTED'), false);
  } finally { env.cleanup(); }
});

test('a source change with unconfirmed cleanup stays an error', { timeout: 30000 }, async () => {
  const { env, request } = setup('echo tests 1');
  const transport = { description: env.transport.description, isConnectionFailure: () => false,
    start: editDuringUpload(request.sourceRoot, (command) => {
      const remote = env.transport.start(command);
      if (!command.includes('fleet-runner-supervisor')) return remote;
      // Drop only the lock-release confirmation.
      let pending = '';
      const filtered = new Transform({ transform(chunk, _encoding, done) {
        pending += chunk.toString();
        for (;;) {
          const newline = pending.indexOf('\n');
          if (newline < 0) break;
          const line = pending.slice(0, newline + 1);
          pending = pending.slice(newline + 1);
          if (!line.startsWith('@@FR RELEASED')) this.push(line);
        }
        done();
      }});
      remote.stdout.pipe(filtered);
      return { ...remote, stdout: filtered };
    }) };
  try {
    const run = await runProfile({ ...request, transport });
    assert.equal(run.receipt.outcome, 'error', JSON.stringify(run.receipt));
    assert.equal(run.receipt.abort, null);
    assert.match(run.receipt.summary, /changed after planning\. Run again once edits settle\. Lock release not confirmed/);
  } finally { env.cleanup(); }
});

test('profile scratch directly under JOB_DIR is removed too', { timeout: 30000 }, async () => {
  const { env, request } = setup('mkdir -p "$FLEET_RUNNER_JOB_DIR/derived.noindex"; echo scratch > "$FLEET_RUNNER_JOB_DIR/derived.noindex/file"; echo tests 1');
  try {
    const run = await runProfile(request);
    assert.equal(run.receipt.outcome, 'passed');
    assert.equal(existsSync(join(env.remoteRoot, 'jobs', run.receipt.jobId, 'derived.noindex')), false);
  } finally { env.cleanup(); }
});


test('cancellation during upload stops the receiver before scratch is removed', { timeout: 30000 }, async () => {
  const env = testEnvironment();
  const session = new JobSession(env.transport, supervisorCommand(testMachine(), { jobId: 'upload-test', nonce: 'abc', timeoutSeconds: 5, label: 'fixture/test' }), 'abc', { onJobStdout: () => {}, onStderr: () => {} });
  let uploader: ReturnType<typeof env.transport.start> | undefined;
  try {
    const ready = await session.waitFor(['READY'], 5000);
    const chunks = [];
    for await (const chunk of tarStream([
      {kind:'data',name:'meta/command.sh',mode:0o755,data:Buffer.from('echo tests 1')},
      {kind:'data',name:'src/first.bin',mode:0o644,data:Buffer.alloc(1024*1024,1)},
      {kind:'data',name:'src/late.txt',mode:0o644,data:Buffer.from('late')},
    ])) chunks.push(chunk);
    const archive = Buffer.concat(chunks);
    uploader = env.transport.start(uploadCommand(ready.rest));
    uploader.stdout.resume(); uploader.stderr.resume();
    let exited = false; uploader.exited.then(() => { exited = true; });
    uploader.stdin.write(archive.subarray(0,128*1024));
    assert.equal(await waitUntil(() => existsSync(join(ready.rest,'src/first.bin')),5000),true);
    session.send('ABORT'); await session.waitFor(['BYE'],10000); session.closeInput(); await session.exited;
    assert.equal(await waitUntil(() => exited,2000),true,'receiver must stop without receiving the rest of the archive');
    assert.equal(existsSync(join(ready.rest,'src')),false);
    assert.equal(existsSync(join(env.remoteRoot,'locks/heavy')),false);
  } finally {
    session.closeInput(); await session.exited;
    if (uploader) { uploader.kill(); await uploader.exited; }
    env.cleanup();
  }
});

test('a delayed upload refuses a job that was already cancelled', { timeout: 30000 }, async () => {
  const env = testEnvironment();
  const session = new JobSession(env.transport, supervisorCommand(testMachine(), { jobId: 'late-upload', nonce: 'abc', timeoutSeconds: 5, label: 'fixture/test' }), 'abc', { onJobStdout: () => {}, onStderr: () => {} });
  try {
    const ready = await session.waitFor(['READY'],5000);
    session.send('ABORT'); await session.waitFor(['BYE'],5000); session.closeInput(); await session.exited;
    const status = await fetchStatus(env.transport, testMachine());
    assert.equal(status.jobs[0]?.startedEpoch, undefined);
    const late = env.transport.start(uploadCommand(ready.rest));
    late.stdout.resume(); late.stderr.resume(); late.stdin.end();
    assert.notEqual((await late.exited).code,0);
    assert.equal(existsSync(join(ready.rest,'src')),false);
  } finally { session.closeInput(); await session.exited; env.cleanup(); }
});

test('CLI cancellation before test start returns cancelled with confirmed cleanup', { timeout: 30000 }, async () => {
  const { env, request, interrupts } = setup('echo tests 1');
  try {
    const run = await runProfile({ ...request, io: { ...request.io, status: (line) => {
      if (line.startsWith('Uploading')) interrupts.trigger();
    } } });
    assert.equal(run.exitCode, 7);
    assert.equal(run.receipt.outcome, 'cancelled');
    assert.equal(run.receipt.timing.remoteStartedAt, null);
    assert.equal(run.receipt.remote.lockReleased, true);
  } finally { env.cleanup(); }
});

for (const end of ['completed', 'failed', 'timeout', 'cancelled', 'disconnected'] as const) {
  test(`finalizer runs after ${end} before source deletion`, { timeout: 30000 }, async () => {
    const slow = ['timeout', 'cancelled', 'disconnected'].includes(end);
    const { env, request, interrupts } = setup(slow ? 'echo RUNNING; sleep 20' : `echo tests 1; exit ${end === 'failed' ? 7 : 0}`, {
      ...(end === 'timeout' ? { timeoutMinutes: .05 } : {}),
      finalizer: { argv: ['bash', '-c', 'test -f run.sh && echo FINALIZER_SAW_SOURCE'], timeoutSeconds: 3 },
    });
    let supervisor: ReturnType<typeof env.transport.start> | undefined;
    const transport = { description: env.transport.description, isConnectionFailure: () => false, start: (command: string) => {
      const p = env.transport.start(command); if (command.includes('fleet-runner-supervisor')) supervisor = p; return p;
    } };
    try {
      const pending = runProfile({ ...request, transport });
      if (end === 'cancelled' || end === 'disconnected') {
        assert.equal(await waitUntil(() => env.stdout.text.includes('RUNNING'), 10000), true);
        if (end === 'cancelled') interrupts.trigger(); else supervisor?.stdin.end();
      }
      const run = await pending;
      assert.equal(run.receipt.outcome, end === 'completed' ? 'passed' : end === 'failed' ? 'failed' : end === 'timeout' ? 'timed-out' : 'cancelled', JSON.stringify(run.receipt));
      const directory = join(env.remoteRoot, 'jobs', run.receipt.jobId);
      assert.equal(existsSync(join(directory, 'finalizer.done')), true);
      assert.match(readFileSync(join(directory, 'finalizer.log'), 'utf8'), /FINALIZER_SAW_SOURCE/);
      assert.equal(existsSync(join(directory, 'src')), false);
      assert.equal(run.receipt.remote.lockReleased, true);
    } finally { env.cleanup(); }
  });
}

test('failed finalizer retains ownership and source; explicit stale recovery retries it', { timeout: 30000 }, async () => {
  const { env, request } = setup('echo tests 1', { finalizer: { argv: ['bash', '-c', 'test -f "$FLEET_RUNNER_JOB_DIR/allow-finalizer"'], timeoutSeconds: 3 } });
  try {
    const run = await runProfile(request);
    const directory = join(env.remoteRoot, 'jobs', run.receipt.jobId);
    assert.equal(run.receipt.outcome, 'error');
    assert.equal(run.receipt.remote.lockReleased, false);
    assert.equal(existsSync(join(directory, 'src/run.sh')), true);
    assert.equal((await runControl(env.transport, testMachine(), 'clear-stale')).result, 'finalizer-failed');
    assert.equal(existsSync(join(directory, 'src/run.sh')), true);
    writeFileSync(join(directory, 'allow-finalizer'), '');
    assert.equal((await runControl(env.transport, testMachine(), 'clear-stale')).result, 'cleared');
    assert.equal(existsSync(join(directory, 'finalizer.done')), true);
    assert.equal(existsSync(join(directory, 'src')), false);
  } finally { env.cleanup(); }
});

test('stale finalizer retry captures newly prepared artifacts before deleting source', { timeout: 30000 }, async () => {
  const { env, request } = setup('echo tests 1; exit 7', {
    artifacts: ['reports/result.txt'],
    finalizer: { argv: ['bash', '-c', 'test -f "$FLEET_RUNNER_JOB_DIR/allow-finalizer" || exit 1; mkdir -p reports; echo recovered-finalizer-report > reports/result.txt'], timeoutSeconds: 3 },
  });
  try {
    const run = await runProfile(request);
    const directory = join(env.remoteRoot, 'jobs', run.receipt.jobId);
    assert.equal(run.receipt.remote.exitCode, 7);
    assert.equal(run.receipt.remote.lockReleased, false);
    const originalResult = readFileSync(join(directory, 'result'), 'utf8');
    writeFileSync(join(directory, 'allow-finalizer'), '');
    assert.equal((await runControl(env.transport, testMachine(), 'clear-stale')).result, 'cleared');
    assert.equal(existsSync(join(directory, 'artifacts.pending')), true, 'stale cleanup must preserve the newly prepared reports');
    assert.equal(existsSync(join(directory, 'src')), false);
    assert.equal(readFileSync(join(directory, 'result'), 'utf8'), originalResult);
    // A repeated stale clear must reuse the pending snapshot, not recapture
    // different files left by an interrupted cleanup/recovery attempt.
    const savedArchive = readFileSync(join(directory, 'artifacts.tar'));
    writeFiles(directory, { 'src/reports/result.txt': 'different source', 'job-started': '' });
    mkdirSync(join(env.remoteRoot, 'locks/heavy'));
    writeFileSync(join(env.remoteRoot, 'locks/heavy/owner'), `job_id=${run.receipt.jobId}\nsupervisor_pid=99999999\njob_dir=${directory}\n`);
    assert.equal((await runControl(env.transport, testMachine(), 'clear-stale')).result, 'cleared');
    assert.deepEqual(readFileSync(join(directory, 'artifacts.tar')), savedArchive);
    const recovered = await recoverArtifacts(env.paths, env.transport, testMachine(), run.receipt.jobId);
    assert.equal(readFileSync(join(recovered, 'reports/result.txt'), 'utf8'), 'recovered-finalizer-report\n');
    assert.equal(existsSync(join(directory, 'artifacts.pending')), false);
    assert.equal(readFileSync(join(directory, 'result'), 'utf8'), originalResult);
    assert.equal(JSON.parse(readFileSync(run.receiptPath, 'utf8')).outcome, 'error', 'recovery must not turn the original failed run into a pass');
  } finally { env.cleanup(); }
});

for (const failure of ['missing', 'oversize', 'archive-write'] as const) {
  test(`stale artifact ${failure} failure keeps the only source copy and ownership`, { timeout: 30000 }, async () => {
    const prepare = failure === 'missing' ? 'echo no-report' : failure === 'oversize'
      ? `mkdir -p reports; python3 -c "with open('reports/result.txt','wb') as f: f.truncate(2*1024*1024)"`
      : 'mkdir -p reports; echo report > reports/result.txt';
    const { env, request } = setup('echo tests 1; exit 7', {
      artifacts: ['reports/result.txt'], maxArtifactMiB: 1,
      finalizer: { argv: ['bash', '-c', `test -f "$FLEET_RUNNER_JOB_DIR/allow-finalizer" || exit 1; ${prepare}`], timeoutSeconds: 3 },
    });
    try {
      const run = await runProfile(request);
      const directory = join(env.remoteRoot, 'jobs', run.receipt.jobId);
      const originalResult = readFileSync(join(directory, 'result'), 'utf8');
      writeFileSync(join(directory, 'allow-finalizer'), '');
      if (failure === 'archive-write') mkdirSync(join(directory, 'artifacts.tar.part'));
      assert.equal((await runControl(env.transport, testMachine(), 'clear-stale')).result, 'artifact-capture-failed');
      assert.equal(existsSync(join(directory, 'src/run.sh')), true);
      assert.equal(existsSync(join(env.remoteRoot, 'locks/heavy')), true);
      assert.equal(existsSync(join(directory, 'artifacts.pending')), false);
      assert.equal(readFileSync(join(directory, 'result'), 'utf8'), originalResult);
    } finally { env.cleanup(); }
  });
}

test('finalizer stops a finite detached resource outside the ordinary job group', { timeout: 30000 }, async () => {
  const launch = `const c=require('node:child_process').spawn(process.execPath,['-e','const fleet_detached_fixture=1;setTimeout(()=>{},15000)'],{detached:true,stdio:'ignore'});require('node:fs').writeFileSync(process.env.FLEET_RUNNER_JOB_DIR+'/detached.pid',String(c.pid));c.unref()`;
  const stop = `const fs=require('node:fs'),cp=require('node:child_process');const pid=Number(fs.readFileSync(process.env.FLEET_RUNNER_JOB_DIR+'/detached.pid','utf8'));if(!cp.execFileSync('ps',['-o','command=','-p',String(pid)],{encoding:'utf8'}).includes('fleet_detached_fixture'))throw Error('Unverified fixture owner');process.kill(pid,'SIGTERM');console.log('DETACHED_PID='+pid)`;
  const { env, request } = setup(`set -e; ${shellQuote(process.execPath)} -e ${shellQuote(launch)}; echo tests 1`, { finalizer: { argv: [process.execPath, '-e', stop], timeoutSeconds: 3 } });
  try {
    const run = await runProfile(request);
    const directory = join(env.remoteRoot, 'jobs', run.receipt.jobId);
    assert.equal(run.receipt.outcome, 'passed', JSON.stringify(run.receipt) + readFileSync(join(directory, 'finalizer.log'), 'utf8'));
    const pid = Number(/DETACHED_PID=(\d+)/.exec(readFileSync(join(directory, 'finalizer.log'), 'utf8'))?.[1]);
    assert.ok(pid > 0);
    assert.equal(await waitUntil(() => {
      try { return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim().match(/^[^Z]/); }
      catch { return true; }
    }, 3000), true);
  } finally { env.cleanup(); }
});

test('TERM-resistant finalizer is bounded and keeps failed cleanup for explicit recovery', { timeout: 30000 }, async () => {
  const { env, request } = setup('echo tests 1', { finalizer: { argv: ['bash', '-c', 'trap "" TERM; sleep 20'], timeoutSeconds: 1 } });
  try {
    const run = await runProfile(request);
    const directory = join(env.remoteRoot, 'jobs', run.receipt.jobId);
    assert.equal(run.receipt.outcome, 'error');
    assert.match(readFileSync(join(directory, 'finalizer.result'), 'utf8'), /timeout=1\nstuck=0/);
    assert.equal(existsSync(join(directory, 'src/run.sh')), true);
    assert.equal(run.receipt.remote.lockReleased, false);
  } finally { env.cleanup(); }
});

test('verification failure retains the only remote archive until verified recovery', { timeout: 30000 }, async () => {
  const { env, request } = setup('echo retained-result > result.txt; echo tests 1', { artifacts: ['result.txt'] });
  const transport = { description: env.transport.description, isConnectionFailure: () => false, start: (command: string) => {
    const remote = env.transport.start(command);
    if (!command.includes('fleet-runner-supervisor')) return remote;
    // Change only protocol hash bytes; preserve the actual archive byte for byte.
    const filtered = new Transform({ transform(chunk: Buffer, _encoding, done) {
      const copy = Buffer.from(chunk); const marker = copy.indexOf(Buffer.from('@@FR AF '));
      if (marker >= 0 && copy.length >= marker + 8 + 64) copy.fill(0x30, marker + 8, marker + 8 + 64);
      this.push(copy); done();
    }});
    remote.stdout.pipe(filtered); return { ...remote, stdout: filtered };
  } };
  try {
    const run = await runProfile({ ...request, transport });
    const directory = join(env.remoteRoot, 'jobs', run.receipt.jobId);
    assert.equal(run.exitCode, 8, JSON.stringify(run.receipt));
    assert.equal(run.receipt.outcome, 'error', 'a hash mismatch is a verification error, never a job result');
    assert.equal(existsSync(join(directory, 'artifacts.pending')), true);
    assert.equal(existsSync(join(directory, 'artifacts.tar')), true);
    assert.equal(existsSync(join(directory, 'src')), false);
    const recovered = await recoverArtifacts(env.paths, env.transport, testMachine(), run.receipt.jobId);
    assert.equal(readFileSync(join(recovered, 'result.txt'), 'utf8'), 'retained-result\n');
    assert.equal(existsSync(join(directory, 'artifacts.pending')), false);
    assert.equal(existsSync(join(directory, 'artifacts.tar')), false);
  } finally { env.cleanup(); }
});

test('normal return still retains a bounded archive when remote hash collection fails', { timeout: 30000 }, async () => {
  const { env, request } = setup('echo report > result.txt; echo tests 1', { artifacts: ['result.txt'] });
  let injected = false;
  const transport = { description: env.transport.description, isConnectionFailure: () => false, start: (command: string) => {
    if (command.includes('fleet-runner-supervisor')) {
      const target = 'find "$@" -type f -exec $_sha {} + 2>/dev/null';
      assert.ok(command.includes(target));
      command = command.replace(target, 'false');
      injected = true;
    }
    return env.transport.start(command);
  } };
  try {
    const run = await runProfile({ ...request, transport });
    assert.equal(injected, true);
    const directory = join(env.remoteRoot, 'jobs', run.receipt.jobId);
    assert.notEqual(run.exitCode, 0);
    assert.equal(existsSync(join(directory, 'artifacts.pending')), true, 'hash failure must not erase the only output archive');
    assert.equal(existsSync(join(directory, 'artifacts.tar')), true);
  } finally { env.cleanup(); }
});

test('EOF after artifact transfer does not acknowledge verified return', { timeout: 30000 }, async () => {
  const { env, request } = setup('echo result > result.txt; echo tests 1', { artifacts: ['result.txt'] });
  const transport = { description: env.transport.description, isConnectionFailure: () => false, start: (command: string) => {
    const remote = env.transport.start(command);
    if (!command.includes('fleet-runner-supervisor')) return remote;
    const input = new Writable({ write(chunk, _encoding, done) {
      if (chunk.toString() === 'ACK\n') remote.stdin.end(); else remote.stdin.write(chunk);
      done();
    }, final(done) { remote.stdin.end(); done(); } });
    return { ...remote, stdin: input };
  } };
  try {
    const run = await runProfile({ ...request, transport });
    const directory = join(env.remoteRoot, 'jobs', run.receipt.jobId);
    assert.equal(existsSync(join(directory, 'artifacts.pending')), true);
    assert.equal(existsSync(join(directory, 'artifacts.tar')), true);
    const recovered = await recoverArtifacts(env.paths, env.transport, testMachine(), run.receipt.jobId);
    assert.equal(readFileSync(join(recovered, 'result.txt'), 'utf8'), 'result\n');
  } finally { env.cleanup(); }
});

test('pending archive count refuses admission instead of deleting the only result', { timeout: 30000 }, async () => {
  const { env, request } = setup('echo tests 1');
  writeFiles(env.remoteRoot, { 'jobs/retained/.fleet-job': '', 'jobs/retained/artifacts.pending': '' });
  try {
    const machine = testMachine({ limits: { ...testMachine().limits, keepJobs: 1 } });
    const run = await runProfile({ ...request, machine });
    assert.equal(run.receipt.outcome, 'error');
    assert.match(run.receipt.summary, /recover pending artifacts/);
    assert.equal(existsSync(join(env.remoteRoot, 'jobs/retained/artifacts.pending')), true);
  } finally { env.cleanup(); }
});
