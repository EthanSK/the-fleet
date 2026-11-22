# The job owns its installed dependencies. The retained tree is a snapshot
# seeded only by a successful setup and never used as a live module directory.
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys


def run():
    job = Path(os.environ['FLEET_RUNNER_JOB_DIR'])
    source = Path(os.environ['FLEET_RUNNER_SRC_DIR']).resolve()
    cwd = Path.cwd().resolve()
    cwd_key = str(cwd.relative_to(source))
    meta = job / 'meta'
    config = json.loads((meta / 'cache-setup.json').read_bytes())
    script = meta / 'cache-setup.sh'
    setup_environment = dict(os.environ)
    for name in config.get('executionOnlyEnvironment', ()):
        setup_environment.pop(name, None)
    directory = config['directory']
    if not directory or Path(directory).name != directory or directory in ('.', '..'):
        raise ValueError('invalid cached setup directory')
    installed = cwd / directory
    if os.path.lexists(installed):
        raise ValueError('cached setup output already exists in the uploaded source')

    def install():
        print('Fleet setup: running install steps.', flush=True)
        subprocess.run(['/bin/bash', script], check=True, env=setup_environment)
        if not stat.S_ISDIR(installed.lstat().st_mode):
            raise ValueError('cached setup did not produce a real directory')

    if sys.platform != 'darwin':
        install()
        return

    key = setup_key(config, script, source, cwd_key, setup_environment)
    cache = Path(os.environ['FLEET_RUNNER_CACHE_DIR'])
    if cache.resolve() != cache:
        raise ValueError('cached setup root is not a real directory')
    store = cache / '.fleet-runner-setup'
    store.mkdir(mode=0o700, exist_ok=True)
    if not stat.S_ISDIR(store.lstat().st_mode):
        raise ValueError('cached setup store is not a real directory')
    retained = store / key
    if os.path.lexists(retained):
        if not stat.S_ISDIR(retained.lstat().st_mode):
            raise ValueError('retained setup is not a real directory')
        try:
            clone(retained, installed)
        except subprocess.CalledProcessError:
            if installed.is_dir():
                shutil.rmtree(installed)
        else:
            print('Fleet setup: restored isolated dependencies.', flush=True)
            return

    install()
    try:
        if reusable_tree(installed, source):
            retain(job, cache, installed, retained, config['maxKiB'])
    except (OSError, subprocess.CalledProcessError, ValueError, IndexError):
        # Retention is optional after a successful install. The supervisor
        # owns and removes any partial clone in this exact job folder.
        print('Fleet setup: install succeeded without retaining a copy.', flush=True)


def setup_key(config, script, source, cwd_key, setup_environment):
    inputs = []
    for name in config['inputs']:
        path = source / name
        if path.resolve() != path or not stat.S_ISREG(path.lstat().st_mode):
            raise ValueError('cached setup input is not a regular source file')
        content = hashlib.sha256()
        with path.open('rb') as file:
            for block in iter(lambda: file.read(1024 * 1024), b''):
                content.update(block)
        inputs.append((name, content.hexdigest()))
    runtime = []
    for argv in config['runtime']:
        name = os.path.basename(argv[0])
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+\-]{0,63}', name):
            name = 'tool'
        executable = shutil.which(argv[0], path=setup_environment.get('PATH'))
        if executable is None:
            raise ValueError(f'runtime probe tool {name} was not found')
        try:
            version = subprocess.check_output([executable, *argv[1:]], stderr=subprocess.STDOUT, env=setup_environment)
        except subprocess.CalledProcessError as error:
            outcome = f'exit status {error.returncode}' if error.returncode >= 0 else f'signal {-error.returncode}'
            print(f'Fleet setup: runtime probe for {name} failed ({outcome}).', file=sys.stderr)
            raise
        except OSError:
            raise ValueError(f'runtime probe for {name} could not start') from None
        runtime.append((argv, os.path.realpath(executable), hashlib.sha256(version).hexdigest()))
    environment = [(name, setup_environment.get(name)) for name in config['environment']]
    platform = os.uname()
    identity = ('setup-v1', cwd_key, config['directory'], inputs, runtime, environment, config['declaredEnvironment'],
                platform.sysname, platform.release, platform.machine)
    digest = hashlib.sha256(json.dumps(identity).encode())
    digest.update(script.read_bytes())
    return digest.hexdigest()


def reusable_tree(directory, source):
    def fail(error):
        raise error

    for parent, directories, files in os.walk(directory, followlinks=False, onerror=fail):
        for name in directories + files:
            path = Path(parent) / name
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                target = os.readlink(path)
                resolved = os.path.normpath(path.parent / target)
                if os.path.isabs(target) or os.path.commonpath((source, resolved)) != str(source):
                    return False
            elif not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                return False
    return True


def clone(source, destination):
    subprocess.run(['/bin/cp', '-cRpP', source, destination], check=True, stdin=subprocess.DEVNULL)


def retain(job, cache, installed, retained, limit):
    # All optional source/setup publications share the short budget guard.
    # The supervisor's cache usage guard separately prevents cache eviction.
    key = hashlib.sha256(cache.name.encode()).hexdigest()
    guard = job.parent.parent / 'locks' / ('source-publish-' + key)
    pending = job / 'setup-cache.pending'
    fd = os.open(guard, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        if os.path.lexists(retained):
            return
        clone(installed, pending)
        # Measure the actual candidate in the same units as whole-cache
        # eviction. An incomplete du measurement leaves the install private.
        pending_kib = allocated_kib(pending)
        cache_kib = allocated_kib(cache)
        if cache_kib + pending_kib <= limit:
            pending.rename(retained)
    finally:
        os.close(fd)
        shutil.rmtree(pending, ignore_errors=True)


def allocated_kib(directory):
    output = subprocess.check_output(['/usr/bin/du', '-sk', directory], stderr=subprocess.DEVNULL)
    return int(output.split(maxsplit=1)[0])


try:
    run()
except subprocess.CalledProcessError as error:
    sys.exit(error.returncode if error.returncode > 0 else 1)
except (OSError, ValueError) as error:
    print('Fleet setup: ' + str(error), file=sys.stderr)
    sys.exit(1)
