# Inline worker for opt-in rsync source transfer. The named profile cache owns
# one marked source copy per project. Only filtered source goes there; command
# scripts, machine env and other per-job metadata never enter the cache.
# A dirty marker makes interrupted copies disposable at the next guarded sync.
# Execution always uses a fresh copy, never hardlinks to mutable cached files.
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
source_owner = None
tree = None
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

def cache_bytes(directory):
    total = 0
    for parent, directories, files in os.walk(directory, followlinks=False):
        active()
        for name in directories + files:
            try:
                info = os.lstat(os.path.join(parent, name))
            except FileNotFoundError:
                # Concurrent cache tools rename temporary entries normally.
                # Only this approximate measurement tolerates vanished files;
                # verify_tree still checks every declared source byte.
                continue
            if stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
                total += info.st_size
    return total

def discard_tree():
    if tree is not None and os.path.lexists(tree):
        if os.path.islink(tree) or not os.path.isdir(tree):
            os.unlink(tree)
        else:
            shutil.rmtree(tree)

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
    if not identifier.fullmatch(project) or not identifier.fullmatch(cache_name):
        fail('invalid source cache name')
    cache_key = hashlib.sha256(cache_name.encode()).hexdigest()
    cache_usage_guard = os.open(os.path.join(root, 'locks', 'cache-usage-' + cache_key), os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(cache_usage_guard, fcntl.LOCK_SH)
    max_bytes, max_file, cache_limit = (config[name] for name in ('maxBytes', 'maxFileBytes', 'cacheBytes'))
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
    # Synchronize only mutable retained source, not the whole job. A waiting
    # receiver is cancelled by the existing upload deadline/guard. No polling
    # sleep is introduced: the kernel wakes it when the previous sync exits.
    source_key = hashlib.sha256((cache_name + '/' + project).encode()).hexdigest()
    source_guard = os.open(os.path.join(root, 'locks', 'source-' + source_key), os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(source_guard, fcntl.LOCK_EX)
    active()
    cache = safe_directory(safe_directory(root, 'cache'), cache_name)
    sources = safe_directory(cache, '.fleet-runner-sources')
    source_owner = safe_directory(sources, project)
    marker = os.path.join(source_owner, '.fleet-source')
    if os.path.lexists(marker):
        if os.path.islink(marker) or open(marker).read() != project:
            fail('source cache ownership differs')
    elif os.listdir(source_owner):
        fail('source cache has no ownership marker')
    else:
        with open(marker, 'x') as output:
            output.write(project)
    tree = os.path.join(source_owner, 'tree')
    dirty = os.path.join(source_owner, 'dirty')
    if os.path.lexists(dirty) or (os.path.lexists(tree) and not os.path.isdir(tree)) or os.path.islink(tree):
        discard_tree()
    # Include rsync's temporary replacement bytes, not just its final tree.
    # Never evict another cache consumer's dependencies to make source fit.
    reserve = 2 * total + 256 * len(entries)
    if cache_bytes(cache) + reserve > cache_limit:
        discard_tree()
    if cache_bytes(cache) + reserve > cache_limit:
        if not concurrent_cache and cache_bytes(cache) > cache_limit:
            fail('named cache exceeds its limit; unrelated dependencies were preserved')
        # The cache name is shared: dependency data is not ours to evict.
        # Keep rsync/verification and the same source limits, but receive into
        # disposable job scratch when its retained source copy cannot fit.
        tree = os.path.join(job, 'source-rsync.noindex')
        dirty = os.path.join(job, 'source-rsync.dirty')
        print('fleet-runner: source cache full; using disposable job source', file=sys.stderr)
    with os.fdopen(os.open(dirty, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600), 'w') as output:
        output.write('sync in progress')
    if tree == os.path.join(source_owner, 'tree'):
        safe_directory(source_owner, 'tree')
    else:
        safe_directory(job, 'source-rsync.noindex')
    status = subprocess.call(['/usr/bin/rsync', *arguments[:-1], tree + '/'], pass_fds=(guard, source_guard, cache_usage_guard))
    if status != 0:
        fail('rsync receiver failed')
    active()
    verify_tree(tree, entries, parents)
    cache_overflow = cache_bytes(cache) > cache_limit
    if cache_overflow and not concurrent_cache:
        fail('named cache exceeded its limit')
    destination = os.path.join(job, 'src')
    os.mkdir(destination, 0o700)
    for parent in sorted(parents, key=lambda value: (value.count('/'), value)):
        os.mkdir(os.path.join(destination, parent), 0o755)
    for relative, entry in entries.items():
        active()
        target = os.path.join(destination, relative)
        if entry['kind'] == 'link':
            os.symlink(entry['target'], target)
            continue
        digest = hashlib.sha256()
        copied = 0
        with os.fdopen(os.open(os.path.join(tree, relative), os.O_RDONLY | os.O_NOFOLLOW), 'rb') as source, open(target, 'xb') as output:
            while True:
                active()
                data = source.read(1024 * 1024)
                if not data:
                    break
                copied += len(data)
                if copied > entry['size']:
                    fail('source grew during materialization')
                output.write(data)
                digest.update(data)
        if copied != entry['size'] or digest.hexdigest() != entry['sha256']:
            fail('source changed during materialization')
        os.chmod(target, entry['mode'])
    verify_tree(destination, entries, parents)
    active()
    # A concurrent neighbour may grow dependencies during our transfer. The
    # cap governs retention, not admission: discard only our own retained
    # source, after the independent execution copy has been fully verified.
    if concurrent_cache and cache_overflow and tree == os.path.join(source_owner, 'tree'):
        discard_tree()
    with open(os.path.join(job, 'meta', 'rsync-verified'), 'x') as output:
        output.write(config['digest'])
    os.unlink(dirty)
except Exception as error:
    # Only the marked project source is ours to discard. A hard kill leaves
    # dirty in place so the next admitted sync discards that same tree.
    if source_owner is not None and tree is not None:
        discard_tree()
    print('fleet-runner: ' + str(error), file=sys.stderr)
    sys.exit(1)
