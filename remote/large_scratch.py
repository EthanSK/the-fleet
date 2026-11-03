"""Create bounded output-transfer archives; place large ones on a verified private volume.

Uploaded per job. The supervisor and ACK recovery share these functions. Hot
source/cache/TMPDIR paths never move. File descriptors pin the verified volume;
an absent or replaced mount must never turn into an internal /Volumes write.
"""
from __future__ import annotations
import contextlib
import fcntl
import json
import os
from pathlib import Path
import plistlib
import re
import resource
import secrets
import shutil
import stat
import subprocess
import sys
from typing import BinaryIO, Callable, Iterator, TypedDict

DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
ROOT_MARKER = '.the-fleet-large-archives'
OWNER_MARKER = '.owner.json'
ROOT_VALUE = {'schemaVersion': 1, 'purpose': 'The Fleet large output archives'}


class InsufficientScratchSpace(ValueError):
    """The existing free-space check refused capture; not a generic I/O error."""


class ScratchSettings(TypedDict):
    mountPoint: str
    volumeUuid: str
    directory: str
    minFileMiB: float
    minFreeGiB: float


class ArchiveOwner(TypedDict):
    job: str
    token: str
    folder: str


def checked_job(value: str | Path) -> Path:
    job = Path(value)
    if not job.is_absolute() or job.is_symlink() or not re.fullmatch(r'[a-z0-9][a-z0-9-]*', job.name) or not (job / '.fleet-job').is_file():
        raise ValueError('The Fleet job folder is not verified.')
    return job


@contextlib.contextmanager
def archive_guard(job: Path) -> Iterator[int]:
    fd = os.open(job / 'archive.guard', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield fd
    finally:
        os.close(fd)


def read_json_at(fd: int, name: str) -> object:
    child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
    with os.fdopen(child) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 16384:
            raise ValueError('Scratch ownership is not a regular file.')
        return json.load(stream)


def write_new_json_at(fd: int, name: str, value: object) -> None:
    child = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    with os.fdopen(child, 'w') as stream:
        json.dump(value, stream)


def config(job: Path) -> ScratchSettings:
    value: ScratchSettings = json.loads((job / 'meta/large-scratch.json').read_text())
    mount = value['mountPoint']
    parts = value['directory'].split('/')
    if not isinstance(mount, str) or not mount.startswith('/') or mount == '/' or os.path.realpath(mount) != mount:
        raise ValueError('Large scratch needs its exact mounted-volume path.')
    if any(not p or p in ('.', '..') for p in parts) or not any(p.endswith('.noindex') for p in parts):
        raise ValueError('Large scratch needs a dedicated directory below the mount.')
    if not re.fullmatch(r'[A-Za-z0-9-]{4,128}', value['volumeUuid']):
        raise ValueError('Large scratch needs a volume UUID.')
    for name in ('minFileMiB', 'minFreeGiB'):
        number = value[name]
        if isinstance(number, bool) or not isinstance(number, (int, float)) or not 0 <= number < 1048577:
            raise ValueError('Large scratch limits are invalid.')
    return value


def volume_fd(cfg: ScratchSettings, required_bytes: int = 0) -> int:
    mount = cfg['mountPoint']
    if os.path.realpath(mount) != mount or not os.path.ismount(mount):
        raise ValueError('The configured large scratch volume is not mounted.')
    expected = cfg['volumeUuid'].casefold()
    if sys.platform == 'darwin':
        result = subprocess.run(['/usr/sbin/diskutil', 'info', '-plist', mount], check=True, capture_output=True, timeout=10)
        info = plistlib.loads(result.stdout)
        if info.get('MountPoint') != mount or str(info.get('VolumeUUID', '')).casefold() != expected:
            raise ValueError('The large scratch volume identity does not match.')
        device = os.stat(info['DeviceNode']).st_rdev
        if required_bytes and info.get('ReadOnlyVolume', False):
            raise ValueError('The large scratch volume is read-only.')
    elif sys.platform.startswith('linux'):
        matches = [p for p in Path('/dev/disk/by-uuid').iterdir() if p.name.casefold() == expected]
        if len(matches) != 1:
            raise ValueError('The large scratch volume UUID is unavailable.')
        device = matches[0].stat().st_rdev
    else:
        raise ValueError('Volume identity checks are unavailable on this platform.')
    fd = os.open(mount, DIRECTORY)
    try:
        # st_dev and the actual volume device's st_rdev use the same kernel ID
        # on macOS/Linux. This binds the open descriptor to the checked UUID.
        if os.fstat(fd).st_dev != device:
            raise ValueError('The large scratch mount changed during verification.')
        if required_bytes:
            space = os.fstatvfs(fd)
            free = space.f_bavail * space.f_frsize
            if free < required_bytes + int(cfg['minFreeGiB'] * 1024 ** 3):
                raise InsufficientScratchSpace('The large scratch volume has insufficient free space.')
            if not os.access(mount, os.W_OK):
                raise ValueError('The large scratch volume is not writable.')
        return fd
    except BaseException:
        os.close(fd)
        raise


def owner_file(job: Path) -> Path:
    return job / 'meta/large-scratch-owner.json'


def folder_name(job: Path, token: str) -> str:
    # Keep legal long job IDs within a filesystem component's byte limit.
    return job.name[:80] + '-' + token + '.noindex'


def load_owner(job: Path) -> ArchiveOwner:
    value: ArchiveOwner = json.loads(owner_file(job).read_text())
    if value.get('job') != str(job) or not re.fullmatch(r'[0-9a-f]{32}', value.get('token', '')):
        raise ValueError('Large scratch ownership does not match this job.')
    if value.get('folder') != folder_name(job, value['token']):
        raise ValueError('Large scratch ownership has an invalid folder.')
    return value


def check_root(fd: int, create: bool) -> None:
    guard = None
    try:
        if create:
            names = set(os.listdir(fd))
            if '.allocation.guard' not in names and names:
                if names != {ROOT_MARKER} or read_json_at(fd, ROOT_MARKER) != ROOT_VALUE:
                    raise ValueError('The configured scratch root is not owned by The Fleet.')
            try:
                guard = os.open('.allocation.guard', os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=fd)
            except (FileExistsError, FileNotFoundError):
                # Concurrent creation on APFS can report ENOENT even though
                # the other creator's file exists. Open that inode only: no
                # deletion/recreation, timed retry or path fallback.
                guard = os.open('.allocation.guard', os.O_RDWR | os.O_NOFOLLOW, dir_fd=fd)
            regular_at(fd, '.allocation.guard')
            # Serialize first use across jobs; another job must never read a
            # half-written root marker on slower removable filesystems.
            fcntl.flock(guard, fcntl.LOCK_EX)
        try:
            marker = read_json_at(fd, ROOT_MARKER)
        except FileNotFoundError:
            if not create or set(os.listdir(fd)) != {'.allocation.guard'}:
                raise ValueError('The configured scratch root is not owned by The Fleet.')
            write_new_json_at(fd, ROOT_MARKER, ROOT_VALUE)
            marker = read_json_at(fd, ROOT_MARKER)
        if marker != ROOT_VALUE:
            raise ValueError('The configured scratch root has different ownership.')
    finally:
        if guard is not None:
            os.close(guard)


def open_store(job: Path, create: bool = False, required_bytes: int = 0, cleaning: bool = False) -> tuple[int, int | None, ArchiveOwner]:
    cfg = config(job)
    base = volume_fd(cfg, required_bytes)
    try:
        for part in cfg['directory'].split('/'):
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=base)
                except FileExistsError:
                    pass
            child = os.open(part, DIRECTORY, dir_fd=base)
            if os.fstat(child).st_dev != os.fstat(base).st_dev:
                os.close(child)
                raise ValueError('Large scratch crosses another filesystem.')
            os.close(base)
            base = child
        # A configured empty root may be provisioned in advance. Existing
        # unmarked personal contents are never adopted or removed.
        check_root(base, create)
        if create and not owner_file(job).exists():
            token = secrets.token_hex(16)
            value = {'job': str(job), 'token': token, 'folder': folder_name(job, token)}
            # Record the random destination before touching it, so interrupted
            # allocation is visible. A missing/mismatched external marker refuses
            # cleanup rather than guessing ownership after a crash.
            with owner_file(job).open('x') as stream:
                json.dump(value, stream)
            os.mkdir(value['folder'], 0o700, dir_fd=base)
            child = os.open(value['folder'], DIRECTORY, dir_fd=base)
            try:
                write_new_json_at(child, OWNER_MARKER, value)
            finally:
                os.close(child)
        value = load_owner(job)
        try:
            child = os.open(value['folder'], DIRECTORY, dir_fd=base)
        except FileNotFoundError:
            if cleaning:
                return base, None, value
            raise
        try:
            if os.fstat(child).st_dev != os.fstat(base).st_dev:
                raise ValueError('Large scratch ownership changed.')
            try:
                marker = read_json_at(child, OWNER_MARKER)
            except FileNotFoundError:
                # An interrupted cleanup may have removed the marker just
                # before rmdir. Only an empty expected random folder is safe.
                if not cleaning or os.listdir(child):
                    raise ValueError('Large scratch ownership is missing.')
                marker = value
            if marker != value:
                raise ValueError('Large scratch ownership changed.')
        except BaseException:
            os.close(child)
            raise
        return base, child, value
    except BaseException:
        os.close(base)
        raise


def regular_at(fd: int, name: str) -> os.stat_result:
    info = os.stat(name, dir_fd=fd, follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError('Large scratch contains an unexpected archive entry.')
    return info


def write_archive(job: Path, folder: int, maximum_bytes: int, roots: list[str], guard_fd: int, verify_space: Callable[[], None] | None = None) -> None:
    """Extraction of existing fr_capture_artifacts tar writing; adds pinned-FD storage."""
    try:
        regular_at(folder, 'artifacts.tar.part')
        os.unlink('artifacts.tar.part', dir_fd=folder)
    except FileNotFoundError:
        pass
    if verify_space:
        verify_space()
    output = os.open('artifacts.tar.part', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=folder)
    try:
        version = subprocess.run(['tar', '--version'], capture_output=True, text=True, timeout=10)
        flags = ['--no-mac-metadata'] if 'bsdtar' in version.stdout else []
        inherited = [guard_fd]
        # Keep admission/capacity descriptors in tar too. If its parent dies,
        # archive.guard and the kernel lease still expose the writer.
        for name in os.listdir('/dev/fd' if sys.platform == 'darwin' else '/proc/self/fd'):
            if name.isdigit() and int(name) >= 200:
                try:
                    if os.get_inheritable(int(name)):
                        inherited.append(int(name))
                except OSError:
                    pass
        def limit_file():
            resource.setrlimit(resource.RLIMIT_FSIZE, (maximum_bytes, maximum_bytes))
        subprocess.run(['tar', *flags, '-cf', '-', *roots], cwd=job / 'src', stdout=output,
                       env=dict(os.environ, COPYFILE_DISABLE='1'), check=True, timeout=900,
                       pass_fds=tuple(inherited), preexec_fn=limit_file)
    finally:
        os.close(output)
    os.replace('artifacts.tar.part', 'artifacts.tar', src_dir_fd=folder, dst_dir_fd=folder)


def capture(job: Path, logical_bytes: int, maximum_bytes: int, roots: list[str], guard_fd: int) -> str:
    if not 0 <= logical_bytes <= maximum_bytes:
        raise ValueError('Archive size is invalid.')
    if (job / 'artifacts.pending').exists():
        raise ValueError('Recover the unacknowledged archive before capturing again.')
    cfg = config(job) if (job / 'meta/large-scratch.json').exists() else None
    external = owner_file(job).exists() or (cfg is not None and logical_bytes >= cfg['minFileMiB'] * 1024 ** 2)
    if not external:
        folder = os.open(job, DIRECTORY)
        try:
            write_archive(job, folder, maximum_bytes, roots, guard_fd)
        finally:
            os.close(folder)
        return 'internal'
    (job / 'meta/large-scratch-failed').write_text('unverified\n')
    if cfg is None:
        raise ValueError('The saved large scratch configuration is missing.')
    existing = owner_file(job).exists()
    required = logical_bytes + 1048576
    base, folder, value = open_store(job, create=True, required_bytes=0 if existing else required)
    try:
        if folder is None:
            raise ValueError('The owned archive directory is unavailable.')
        def verify_space():
            # Reclaim only this job's partial file before checking replacement
            # space. The second descriptor also rechecks the mounted identity.
            probe = volume_fd(cfg, required)
            try:
                if os.fstat(probe).st_dev != os.fstat(folder).st_dev:
                    raise ValueError('The large scratch mount changed before writing.')
            finally:
                os.close(probe)
        write_archive(job, folder, maximum_bytes, roots, guard_fd, verify_space)
        print('large-scratch-archive=' + str(Path(cfg['mountPoint']) / cfg['directory'] / value['folder'] / 'artifacts.tar'), file=sys.stderr)
        return 'external'
    finally:
        if folder is not None:
            os.close(folder)
        os.close(base)


def open_archive(job: Path) -> BinaryIO:
    if not owner_file(job).exists():
        fd = os.open(job / 'artifacts.tar', os.O_RDONLY | os.O_NOFOLLOW)
    else:
        base, folder, _ = open_store(job)
        try:
            if folder is None:
                raise ValueError('The owned archive directory is unavailable.')
            regular_at(folder, 'artifacts.tar')
            fd = os.open('artifacts.tar', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=folder)
        finally:
            if folder is not None:
                os.close(folder)
            os.close(base)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise ValueError('The returned archive is not a regular file.')
    return os.fdopen(fd, 'rb')


def cleanup_archive(job: Path, acknowledged: bool = False) -> None:
    if not owner_file(job).exists():
        return
    if (job / 'artifacts.pending').exists() and not acknowledged:
        with open_archive(job):
            return  # Keep the only unacknowledged result for verified recovery.
    base, folder, value = open_store(job, cleaning=True)
    try:
        if folder is None:
            # The device and root are verified, and a previous ACK cleanup
            # already removed this exact folder. Retry only local bookkeeping.
            owner_file(job).unlink()
            return
        names = set(os.listdir(folder))
        if not names <= {OWNER_MARKER, 'artifacts.tar', 'artifacts.tar.part'}:
            raise ValueError('Large scratch contains files that this job did not create.')
        for name in names - {OWNER_MARKER}:
            regular_at(folder, name)
        for name in names - {OWNER_MARKER}:
            os.unlink(name, dir_fd=folder)
        if OWNER_MARKER in names:
            os.unlink(OWNER_MARKER, dir_fd=folder)
        os.close(folder)
        folder = -1
        os.rmdir(value['folder'], dir_fd=base)
        owner_file(job).unlink()
    finally:
        if folder is not None and folder >= 0:
            os.close(folder)
        os.close(base)


def main() -> None:
    action, value, *arguments = sys.argv[1:]
    job = checked_job(value)
    with archive_guard(job) as guard_fd:
        if action == 'capture':
            external = (job / 'meta/large-scratch.json').exists() or owner_file(job).exists()
            try:
                logical_bytes = int(arguments[0])
                cfg = config(job) if (job / 'meta/large-scratch.json').exists() else None
                external = owner_file(job).exists() or (cfg is not None and logical_bytes >= cfg['minFileMiB'] * 1024 ** 2)
                print(capture(job, logical_bytes, int(arguments[1]), arguments[2:], guard_fd))
            except Exception as error:
                if external:
                    # A full/read-only internal metadata directory can prevent
                    # even the retention marker. Tell the shell to keep source
                    # and ownership without depending on another disk write.
                    print('The Fleet large scratch: ' + str(error), file=sys.stderr)
                    if isinstance(error, InsufficientScratchSpace):
                        print(json.dumps({'phase': 'archive', 'message': str(error)}))
                        raise SystemExit(75)
                    raise SystemExit(73)
                raise
        elif action == 'size':
            with open_archive(job) as source:
                print(os.fstat(source.fileno()).st_size)
        elif action == 'stream':
            with open_archive(job) as source:
                shutil.copyfileobj(source, sys.stdout.buffer, 1024 * 1024)
        elif action == 'cleanup':
            cleanup_archive(job)
        else:
            raise ValueError('Unknown large scratch action.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('The Fleet large scratch: ' + str(error), file=sys.stderr)
        sys.exit(1)
