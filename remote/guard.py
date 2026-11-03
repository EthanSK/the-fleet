# Fleet Runner's kernel-owned admission guard, sent inline by remoteScripts.ts.
# Hold the same inode through the supervisor's lifetime or one stale cleanup.
# Unlike a removable mkdir lock, flock cannot mistake a later job for an old
# observation, and the kernel releases it when its owning processes exit.
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

root, mode, script, name, *arguments = sys.argv[1:]
if not os.path.isabs(root) or not root.endswith('.noindex') or os.path.normpath(root) != root:
    sys.exit(64)
os.makedirs(os.path.join(root, 'locks'), mode=0o700, exist_ok=True)
descriptor = os.open(os.path.join(root, 'locks', 'admission'), os.O_CREAT | os.O_RDWR, 0o600)
def busy():
    supervisor = mode in ('supervisor', 'shared')
    print('@@FR BUSY admission-in-progress' if supervisor else 'result=busy admission-in-progress', flush=True)
    sys.exit(75 if supervisor else 0)

def lock(fd: int, operation: int) -> None:
    try:
        fcntl.flock(fd, operation | fcntl.LOCK_NB)
    except BlockingIOError:
        busy()

lock(descriptor, fcntl.LOCK_SH if mode == 'shared' else fcntl.LOCK_EX)
# The bash supervisor uses descriptors 3, 4 and 5. Keep this separate, and
# inheritable across exec so a crash cannot silently release admission early.
os.dup2(descriptor, 200, inheritable=True)
if descriptor != 200:
    os.close(descriptor)
os.environ.pop('FR_JOB_LOCK', None)
os.environ.pop('FLEET_RUNNER_SHARED_JOB', None)
os.environ.pop('FLEET_RUNNER_CLAIM_CACHE', None)
if mode != 'shared':
    os.execv('/bin/bash', ['bash', '-c', script, name, *arguments])

# Capacity is bounded again on the actual worker, including clients which
# race between preflight and admission. Every child inherits these same
# open descriptions, so losing the parent never advertises a free slot.
job_id = arguments[1]
if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', job_id):
    sys.exit(64)
claim = json.loads(arguments[8])
slots = claim['slots']
resources = claim['resources']
if type(slots) is not int or not 1 <= slots <= 8 or not isinstance(resources, list) or len(resources) > 32:
    sys.exit(64)
inherited = [200]

def inherit(fd: int) -> int:
    target = 200 + len(inherited)
    os.dup2(fd, target, inheritable=True)
    if fd != target:
        os.close(fd)
    inherited.append(target)
    return target

for index in range(slots):
    fd = os.open(os.path.join(root, 'locks', 'slot-' + str(index)), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        inherit(fd)
        break
    except BlockingIOError:
        os.close(fd)
else:
    busy()
for resource in sorted(set(resources)):
    if not isinstance(resource, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,199}', resource):
        sys.exit(64)
    key = hashlib.sha256(resource.encode()).hexdigest()
    fd = os.open(os.path.join(root, 'locks', 'resource-' + key), os.O_CREAT | os.O_RDWR, 0o600)
    lock(fd, fcntl.LOCK_EX)
    inherit(fd)

cache = claim.get('cache')
cache_fd = None
if cache is not None:
    cache_name = cache['name']
    if not isinstance(cache_name, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}', cache_name):
        sys.exit(64)
    cache_key = hashlib.sha256(cache_name.encode()).hexdigest()
    cache_lock = os.path.join(root, 'locks', 'cache-usage-' + cache_key)
    fd = os.open(cache_lock, os.O_CREAT | os.O_RDWR, 0o600)
    # Access compatibility and retention use distinct inodes. Independent
    # upload receivers can always hold SH usage without deadlocking the same
    # job's deliberately exclusive access claim.
    lock(fd, fcntl.LOCK_SH)
    cache_fd = inherit(fd)
    fd = os.open(os.path.join(root, 'locks', 'cache-access-' + cache_key), os.O_CREAT | os.O_RDWR, 0o600)
    lock(fd, fcntl.LOCK_SH if cache.get('concurrent') is True else fcntl.LOCK_EX)
    inherit(fd)
    os.environ['FLEET_RUNNER_CLAIM_CACHE'] = cache_name

shared_root = os.path.join(root, 'locks', 'shared')
os.makedirs(shared_root, mode=0o700, exist_ok=True)
job_lock = os.path.join(shared_root, job_id)
os.environ['FR_JOB_LOCK'] = job_lock
os.environ['FLEET_RUNNER_SHARED_JOB'] = job_id
status = subprocess.call(['/bin/bash', '-c', script, name, *arguments], pass_fds=tuple(inherited))

# Retention is separate from ordinary job capacity. Closing our usage lock
# before trying EX means another live user (including inherited descendants)
# protects the cache. The last user can prune; never unlink this lock inode.
if cache_fd is not None:
    os.close(cache_fd)
    # A subprocess may close inherited extra descriptors. Its supervisor's
    # recorded cache claim must therefore also protect orphaned/stale jobs,
    # until ownership-checked recovery has finished their cleanup.
    def recorded_user() -> bool:
        for entry in os.scandir(shared_root):
            try:
                with open(os.path.join(entry.path, 'owner')) as owner:
                    fields = dict(line.rstrip('\n').split('=', 1) for line in owner if '=' in line)
                if 'cache_name' not in fields or fields['cache_name'] == cache_name:
                    return True
            except OSError:
                return True
        return False

    if not os.path.lexists(job_lock) and not recorded_user():
        fd = os.open(cache_lock, os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            pass
        else:
            directory = os.path.join(root, 'cache', cache_name)
            if os.path.isdir(directory) and os.path.realpath(directory) == directory and not recorded_user():
                size = int(subprocess.check_output(['du', '-sk', directory], text=True).split()[0])
                if size > claim['cacheMaxKiB']:
                    shutil.rmtree(directory)
        finally:
            os.close(fd)
sys.exit(status)
