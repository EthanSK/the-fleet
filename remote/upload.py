# Fleet Runner's one-job source receiver, sent inline by uploadCommand.
# Keep the transfer guard in tar too. Cleanup waits on the same inode, and
# late uploaders check terminal state while holding that guard.
import fcntl
import os
import signal
import subprocess
import sys
import time

job = sys.argv[1]
if not os.path.isfile(os.path.join(job, '.fleet-job')):
    sys.exit(73)
guard = os.open(os.path.join(job, 'upload.guard'), os.O_CREAT | os.O_RDWR, 0o600)
try:
    fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(75)
if any(os.path.exists(os.path.join(job, name)) for name in ('result', 'cancel-requested', 'src', 'meta')):
    sys.exit(73)
cancelled = False

def interrupt(signum, frame):
    global cancelled
    cancelled = True

for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
    signal.signal(signum, interrupt)
child = subprocess.Popen(['tar', '-xpf', '-'], cwd=job, start_new_session=True, pass_fds=(guard,))
started = ' '.join(subprocess.run(['ps', '-o', 'lstart=', '-p', str(child.pid)], text=True, capture_output=True).stdout.split())
owner = os.path.join(job, 'upload.owner')
with open(owner + '.tmp', 'w') as output:
    output.write('job_pgid=%s\njob_start=%s\njob_dir=%s\n' % (child.pid, started, job))
os.replace(owner + '.tmp', owner)
try:
    while child.poll() is None:
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
    if child.poll() is None:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
    os.close(guard)
