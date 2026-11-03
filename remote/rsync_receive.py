# Inline rsync receiver guardian. Hold the existing per-job upload guard until
# the isolated worker (rsync + validation + materialization) and its children
# stop. Terminal result/cancel markers stop the whole worker process group.
import fcntl
import os
import signal
import subprocess
import sys
import time

job, worker, *arguments = sys.argv[1:]
if not os.path.isabs(job) or os.path.islink(job) or not os.path.isfile(os.path.join(job, '.fleet-job')):
    sys.exit(73)
guard = os.open(os.path.join(job, 'upload.guard'), os.O_CREAT | os.O_RDWR, 0o600)
try:
    fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(75)

def terminal():
    return any(os.path.exists(os.path.join(job, name)) for name in ('result', 'cancel-requested', 'src'))

if terminal() or not os.path.isdir(os.path.join(job, 'meta')):
    sys.exit(73)
cancelled = False

def interrupt(signum, frame):
    global cancelled
    cancelled = True

for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
    signal.signal(signum, interrupt)
if worker != os.path.join(job, 'meta', 'rsync-worker.py') or os.path.islink(worker):
    sys.exit(73)
child = subprocess.Popen([sys.executable, worker, job, str(guard), *arguments], start_new_session=True, pass_fds=(guard,))
owner = os.path.join(job, 'upload.owner')
started = ' '.join(subprocess.run(['ps', '-o', 'lstart=', '-p', str(child.pid)], text=True, capture_output=True).stdout.split())
with open(owner + '.tmp', 'w') as output:
    output.write('job_pgid=%s\njob_start=%s\njob_dir=%s\n' % (child.pid, started, job))
os.replace(owner + '.tmp', owner)
try:
    while child.poll() is None:
        # src is created by this worker, so only terminal control markers apply
        # after launch. EOF during rsync makes rsync itself exit unsuccessfully.
        if cancelled or any(os.path.exists(os.path.join(job, name)) for name in ('result', 'cancel-requested')):
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait()
            sys.exit(1)
        time.sleep(0.1)
    sys.exit(child.returncode if child.returncode >= 0 else 1)
finally:
    # The worker can fail while its rsync child is still alive. Keep the guard
    # through bounded process-group shutdown instead of orphaning the receiver.
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    if child.poll() is None:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
    os.close(guard)
