"""Stream one immutable retained archive; delete only after verified client ACK."""
import fcntl
import contextlib
import json
import os
from pathlib import Path
import re
import runpy
import select
import signal
import sys

root, job_id = sys.argv[1:]
if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', job_id):
    sys.exit(64)
job = Path(root) / 'jobs' / job_id
if job.is_symlink() or not (job / '.fleet-job').is_file() or not (job / 'artifacts.pending').is_file():
    print('@@FR ERROR no retained artifact archive', flush=True)
    sys.exit(1)
lock = os.open(job / 'recovery.guard', os.O_CREAT | os.O_RDWR, 0o600)
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print('@@FR ERROR recovery already active', flush=True)
    sys.exit(1)
signal.alarm(900)
archive = job / 'artifacts.tar'
roots = (job / 'meta/artifacts').read_text().splitlines()
limit = int((job / 'meta/max-artifact-kb').read_text()) * 1024
stack = contextlib.ExitStack()
scratch = None
if (job / 'meta/large-scratch-owner.json').exists():
    # Read the exact helper uploaded for this job, without generating bytecode
    # inside immutable metadata. Its descriptor pins the verified volume.
    sys.dont_write_bytecode = True
    scratch = runpy.run_path(str(job / 'meta/large_scratch.py'))
    stack.enter_context(scratch['archive_guard'](job))
    source = stack.enter_context(scratch['open_archive'](job))
else:
    if archive.is_symlink():
        sys.exit(1)
    source = stack.enter_context(archive.open('rb'))
size = os.fstat(source.fileno()).st_size
if not 1 <= limit <= 8192 * 1024 * 1024 or size > limit + 1048576:
    sys.exit(1)
print('@@FR RECOVERY ' + json.dumps({'roots': roots, 'maxBytes': limit}), flush=True)
for line in (job / 'meta/artifact-hashes').read_text().splitlines():
    if line.startswith('\\') or '  ' not in line:
        continue
    digest, path = line.split('  ', 1)
    print('@@FR AF ' + digest + ' ' + path.removeprefix('./'), flush=True)
print('@@FR ARTIFACTS ' + str(size), flush=True)
try:
    while data := source.read(1024 * 1024):
        sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()
    if select.select([sys.stdin], [], [], 600)[0] and sys.stdin.buffer.readline(1024) == b'ACK\n':
        source.close()
        if scratch:
            scratch['cleanup_archive'](job, acknowledged=True)
        else:
            archive.unlink()
        (job / 'artifacts.pending').unlink()
        print('@@FR RECOVERED', flush=True)
    else:
        print('@@FR RETAINED', flush=True)
    print('@@FR BYE', flush=True)
except (BrokenPipeError, ConnectionError):
    pass  # The pending marker and archive survive loss of the reader.
finally:
    stack.close()
