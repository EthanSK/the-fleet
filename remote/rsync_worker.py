# Inline worker for opt-in rsync source transfer. Only a verified filtered
# source tree can replace a worktree's baseline. Rsync updates a private
# copy, so another upload never mutates the baseline or the job's checkout.
import hashlib
import fcntl
import json
import os
import posixpath
import re
import shutil
import stat
import subprocess
import sys

job, guard_text, *arguments = sys.argv[1:]
guard = int(guard_text)
root = os.path.dirname(os.path.dirname(job))
identifier = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$')

def fail(message):
    raise ValueError(message)

def active():
    if any(os.path.exists(os.path.join(job, name)) for name in ('result', 'cancel-requested')):
        fail('source transfer cancelled')

def safe_directory(parent, name):
    path = os.path.join(parent, name)
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    if not stat.S_ISDIR(os.lstat(path).st_mode):
        fail('cache path is not a directory')
    return path

def read_meta(name):
    path = os.path.join(job, 'meta', name)
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as source:
        data = source.read(16 * 1024 * 1024 + 1)
    if len(data) > 16 * 1024 * 1024:
        fail('source metadata is too large')
    return data

def safe_relative(path):
    return isinstance(path, str) and path and not path.startswith('/') and posixpath.normpath(path) == path and path != '..' and not path.startswith('../') and not any(ord(char) < 32 or ord(char) == 127 for char in path)

def allocated_kib(directory, held_guards):
    # Match the eviction check. A changing cache can make du fail even
    # when it prints a subtotal; that subtotal cannot authorize publication.
    try:
        output = subprocess.check_output(['/usr/bin/du', '-sk', directory],
                                         stderr=subprocess.DEVNULL, pass_fds=held_guards)
        return int(output.split(maxsplit=1)[0])
    except (OSError, subprocess.CalledProcessError, ValueError, IndexError):
        return None

def copy_tree(source, destination, held_guards):
    if sys.platform == 'darwin':
        subprocess.run(['/bin/cp', '-cRpP', source, destination], check=True,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, pass_fds=held_guards)
    else:
        shutil.copytree(source, destination, symlinks=True)

def baseline_path(cache, project, worktree):
    sources = safe_directory(cache, '.fleet-runner-worktrees')
    owner = safe_directory(safe_directory(sources, project), worktree)
    baseline = os.path.join(owner, 'tree')
    if os.path.lexists(baseline) and not stat.S_ISDIR(os.lstat(baseline).st_mode):
        fail('source baseline is not a directory')
    return baseline

def publish_baseline(cache, baseline, seeded_inode, tree, limit, publication_guard, held_guards):
    # Build the replacement privately. All jobs share the same short cache
    # publication lock, while their actual network transfers overlap.
    pending = os.path.join(job, 'source-baseline.noindex')
    previous = os.path.join(job, 'source-previous.noindex')
    fcntl.flock(publication_guard, fcntl.LOCK_EX)
    try:
        current_inode = os.lstat(baseline).st_ino if os.path.isdir(baseline) else None
        if current_inode != seeded_inode:
            return 'kept source baseline published by a concurrent job'
        try:
            copy_tree(tree, pending, held_guards)
        except (OSError, subprocess.CalledProcessError):
            return 'source cache copy failed; using disposable job source'
        pending_kib = allocated_kib(pending, held_guards)
        current_kib = allocated_kib(baseline, held_guards) if current_inode is not None else 0
        cache_kib = allocated_kib(cache, held_guards)
        active()
        if pending_kib is None or current_kib is None or cache_kib is None or current_kib > cache_kib:
            return 'source cache size unverified; using disposable job source'
        if cache_kib - current_kib + pending_kib > limit:
            return 'source cache full; using disposable job source'
        if current_inode is not None:
            os.rename(baseline, previous)
        os.rename(pending, baseline)
    finally:
        fcntl.flock(publication_guard, fcntl.LOCK_UN)
        # A refused or partial clone belongs to this upload. Free it before
        # execution, especially when a non-APFS worker makes a full copy.
        shutil.rmtree(pending, ignore_errors=True)
    return 'published verified worktree baseline'

def file_digest(path, entry):
    digest = hashlib.sha256()
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size != entry['size'] or stat.S_IMODE(info.st_mode) != entry['mode']:
            fail('source size or mode differs from manifest')
        while True:
            active()
            data = source.read(1024 * 1024)
            if not data:
                break
            digest.update(data)
    if digest.hexdigest() != entry['sha256']:
        fail('source hash differs from manifest')

def verify_tree(directory, entries, parents):
    found = set()
    for parent, directories, files in os.walk(directory, followlinks=False):
        active()
        for name in directories + files:
            path = os.path.join(parent, name)
            relative = os.path.relpath(path, directory).replace(os.sep, '/')
            info = os.lstat(path)
            if stat.S_ISDIR(info.st_mode):
                if relative not in parents:
                    fail('unexpected source directory')
                continue
            entry = entries.get(relative)
            if entry is None:
                fail('unexpected source file')
            found.add(relative)
            if entry['kind'] == 'link':
                if not stat.S_ISLNK(info.st_mode) or os.readlink(path) != entry['target']:
                    fail('source symlink differs from manifest')
            else:
                file_digest(path, entry)
    if found != set(entries):
        fail('source file set differs from manifest')

try:
    active()
    if not root.endswith('.noindex') or os.path.realpath(job) != job or os.path.dirname(job) != os.path.join(root, 'jobs'):
        fail('invalid job directory')
    if len(arguments) < 3 or arguments[0] != '--server' or '--sender' in arguments or arguments[-2:] != ['.', 'fleet-runner-source']:
        fail('invalid rsync receiver arguments')
    config = json.loads(read_meta('source-sync.json'))
    project = config['project']
    cache_name = config['cache']
    concurrent_cache = config.get('cacheConcurrent') is True
    worktree = config['worktree']
    if not identifier.fullmatch(project) or not identifier.fullmatch(cache_name) or not re.fullmatch('[0-9a-f]{64}', worktree):
        fail('invalid source cache name or worktree key')
    cache_key = hashlib.sha256(cache_name.encode()).hexdigest()
    cache_usage_guard = os.open(os.path.join(root, 'locks', 'cache-usage-' + cache_key), os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(cache_usage_guard, fcntl.LOCK_SH)
    max_bytes, max_file, cache_limit = (config[name] for name in ('maxBytes', 'maxFileBytes', 'cacheMaxKiB'))
    if any(type(value) is not int or value <= 0 for value in (max_bytes, max_file, cache_limit)):
        fail('invalid source size limit')
    manifest = read_meta('source-manifest.tsv')
    if hashlib.sha256(manifest).hexdigest() != config['digest']:
        fail('source manifest digest differs')
    entries, parents = {}, set()
    total = 0
    for line in manifest.decode('utf8').splitlines():
        fields = line.split('\t')
        if len(fields) != 5:
            fail('invalid source manifest')
        kind, mode, size, value, encoded_path = fields
        relative = json.loads(encoded_path)
        if not safe_relative(relative) or relative in entries:
            fail('invalid source path')
        ancestor = posixpath.dirname(relative)
        while ancestor:
            parents.add(ancestor)
            ancestor = posixpath.dirname(ancestor)
        if kind == 'file':
            mode, size = int(mode, 8), int(size)
            if mode < 0 or mode > 0o777 or size < 0 or size > max_file or not re.fullmatch('[0-9a-f]{64}', value):
                fail('invalid source file record')
            entries[relative] = {'kind': kind, 'mode': mode, 'size': size, 'sha256': value}
            total += size
        elif kind == 'link':
            target = json.loads(value)
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(relative), target)) if isinstance(target, str) else '..'
            if not isinstance(target, str) or not target or target.startswith(('/', '~')) or resolved == '..' or resolved.startswith('../'):
                fail('invalid source symlink')
            entries[relative] = {'kind': kind, 'target': target}
        else:
            fail('invalid source entry kind')
    if not entries or total > max_bytes or int(read_meta('expected-count')) != len(entries) or set(entries) & parents:
        fail('invalid source file set or size')
    cache = safe_directory(safe_directory(root, 'cache'), cache_name)
    publication_guard = os.open(os.path.join(root, 'locks', 'source-publish-' + cache_key),
                                os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    held_guards = (guard, cache_usage_guard, publication_guard)
    tree = os.path.join(job, 'source-rsync.noindex')
    dirty = os.path.join(job, 'source-rsync.dirty')
    with open(dirty, 'x') as output:
        output.write('sync in progress')

    fcntl.flock(publication_guard, fcntl.LOCK_SH)
    try:
        baseline = baseline_path(cache, project, worktree)
        seeded_inode = None
        if not concurrent_cache:
            cache_kib = allocated_kib(cache, held_guards)
            if cache_kib is not None and cache_kib > cache_limit:
                fail('named cache exceeds its limit; unrelated dependencies were preserved')
        if os.path.isdir(baseline):
            seeded_inode = os.lstat(baseline).st_ino
            copy_tree(baseline, tree, held_guards)
            print('fleet-runner: seeded private source from verified worktree baseline', file=sys.stderr)
        else:
            os.mkdir(tree, 0o700)
    finally:
        fcntl.flock(publication_guard, fcntl.LOCK_UN)
    active()
    # Apple forwards its local disk-cache option to the peer. Keep it sender
    # local so older/GNU receivers keep their existing supported options.
    receiver_arguments = [argument for argument in arguments[:-1] if argument != '--cache']
    status = subprocess.call(['/usr/bin/rsync', *receiver_arguments, tree + '/'], pass_fds=held_guards)
    if status != 0:
        fail('rsync receiver failed')
    verify_tree(tree, entries, parents)
    active()
    # The private receiver tree is the exact tree verified above. No digest
    # from a neighbour or published baseline can authorize execution.
    publication = publish_baseline(cache, baseline, seeded_inode, tree, cache_limit, publication_guard, held_guards)
    print('fleet-runner: ' + publication, file=sys.stderr)
    active()
    os.rename(tree, os.path.join(job, 'src'))
    with open(os.path.join(job, 'meta', 'rsync-verified'), 'x') as output:
        output.write(config['digest'])
    os.unlink(dirty)
except Exception as error:
    # Only the exact job owns its private receiving/publishing trees. The
    # supervisor's existing upload guard stops this process before cleanup.
    print('fleet-runner: ' + str(error), file=sys.stderr)
    sys.exit(1)
