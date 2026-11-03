#!/usr/bin/env python3
"""Hold the permanent kernel admission inode across coordinator startup/recovery.

Concurrent CLI auto-starts and launchd share this lock. It is never unlinked.
The child inherits the descriptor, so killing this wrapper cannot admit a
second coordinator while the original still runs.
"""
import fcntl
import os
from pathlib import Path
import signal
import subprocess
import sys
from contextlib import ExitStack
sys.dont_write_bytecode = True
from state_home import resolve_home

requested = os.environ.get("THE_FLEET_HOME") or os.environ.get("FLEET_RUNNER_HOME")
candidate = Path(requested).expanduser().absolute() if requested else Path.home() / ".the-fleet"
arguments = sys.argv[1:]
logging = arguments[:1] == ["--log"]
if logging:
    arguments = arguments[1:]
with ExitStack() as stack:
    inherited = []
    # Shared process-lifetime ownership excludes an atomic home migration.
    if candidate.name in (".fleet-runner", ".the-fleet"):
        migration = stack.enter_context(open(candidate.parent / ".the-fleet-migration.lock", "a+"))
        os.chmod(migration.name, 0o600)
        try:
            fcntl.flock(migration, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            sys.exit(0)
        inherited.append(migration.fileno())
    home = resolve_home(requested, candidate.parent)
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    guard = stack.enter_context(open(home / "service.lock", "a+", encoding="utf-8"))
    os.chmod(guard.name, 0o600)
    try:
        fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit(0)
    inherited.append(guard.fileno())
    environment = dict(os.environ, THE_FLEET_SERVICE_LOCK="held", THE_FLEET_HOME=str(home))
    log = stack.enter_context(open(home / "service.log", "a")) if logging else None
    if logging:
        os.chmod(log.name, 0o600)
    child = subprocess.Popen(arguments, env=environment, pass_fds=tuple(inherited), stdout=log, stderr=log)
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda number, _frame: child.send_signal(number))
    sys.exit(child.wait())
