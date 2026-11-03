"""Run one trusted, idempotent profile finalizer with finite group ownership.

Uploaded per job. Normal completion and explicit stale recovery use this same
implementation. A failed hook keeps source and the heavy lock for inspection.
"""
import fcntl
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

job = Path(sys.argv[1])
if job.is_symlink() or not (job / '.fleet-job').is_file():
    sys.exit(1)
if (job / 'finalizer.done').is_file():
    sys.exit(0)
guard = os.open(job / 'finalizer.guard', os.O_CREAT | os.O_RDWR, 0o600)
try:
    fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(1)

# Survive client/supervisor interruption long enough to finish finite cleanup.
# The hook itself starts a new session with default signal handling.
for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
    signal.signal(sig, signal.SIG_IGN)
seconds = int((job / 'meta/finalizer-seconds').read_text().strip())
if not 1 <= seconds <= 60:
    sys.exit(1)
env = dict(os.environ, FLEET_RUNNER='1', FLEET_RUNNER_JOB_ID=job.name,
           FLEET_RUNNER_JOB_DIR=str(job), FLEET_RUNNER_SRC_DIR=str(job / 'src'))
cache = job / 'meta/cache'
if cache.is_file():
    env['FLEET_RUNNER_CACHE_DIR'] = str(job.parent.parent / 'cache' / cache.read_text().split()[0])
if (job / 'meta/isolated-tmp').is_file():
    env['TMPDIR'] = str(job / 'tmp') + '/'

def alive(pgid):
    rows = subprocess.run(['ps', '-axo', 'pgid=,stat='], capture_output=True, text=True).stdout.splitlines()
    return any(len(parts := row.split()) >= 2 and parts[0] == str(pgid) and not parts[1].startswith('Z') for row in rows)

def stop(pgid):
    for sig, duration in ((signal.SIGTERM, 1), (signal.SIGKILL, 2)):
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            return
        end = time.monotonic() + duration
        while alive(pgid) and time.monotonic() < end:
            time.sleep(.1)

# Preserve the permanent admission inode in the hook too, including if this
# Python parent dies. The per-job guard also survives in remaining children.
descriptors = [guard]
try:
    os.fstat(200)
    descriptors.append(200)
except OSError:
    pass
with (job / 'finalizer.log').open('ab') as log:
    def reset_signals():
        for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            signal.signal(sig, signal.SIG_DFL)
    child = subprocess.Popen(['/bin/bash', str(job / 'meta/finalizer.sh')], cwd=job / 'src',
                             env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                             start_new_session=True, pass_fds=descriptors, preexec_fn=reset_signals)
    started = subprocess.run(['ps', '-o', 'lstart=', '-p', str(child.pid)], capture_output=True, text=True).stdout.strip()
    (job / 'finalizer.owner').write_text(f'job_pgid={child.pid}\njob_start={started}\njob_dir={job}\n')
    timed_out = False
    try:
        code = child.wait(timeout=seconds)
    except subprocess.TimeoutExpired:
        timed_out = True
        stop(child.pid)
        try:
            code = child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            code = -1
    remaining = alive(child.pid)
    # A hook that returns while leaving helpers behind has not finished cleanup.
    if remaining:
        stop(child.pid)
    stuck = alive(child.pid)
    passed = code == 0 and not timed_out and not remaining and not stuck
    (job / 'finalizer.result').write_text(f'exit_code={code}\ntimeout={int(timed_out)}\nstuck={int(stuck)}\n')
    if passed:
        (job / 'finalizer.done').write_text('verified\n')
    sys.exit(0 if passed else 1)
