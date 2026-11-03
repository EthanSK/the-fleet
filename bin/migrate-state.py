#!/usr/bin/env python3
"""Explicit, resumable same-volume state rename. Never runs worker cleanup.

The permanent parent lock excludes every compatible service launcher; the
existing service lock also excludes a pre-upgrade coordinator. Receipt bytes,
worker configuration and reservation tokens are never rewritten.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import plistlib
import stat
import sys
import tempfile
from state_home import RECORD


def atomic_bytes(path, data, mode):
    fd, name = tempfile.mkstemp(prefix=".fleet-migration-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as handle:
            os.fchmod(handle.fileno(), mode)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def write_record(path, record):
    atomic_bytes(path, (json.dumps(record, indent=2) + "\n").encode(), 0o600)


def migrated_path(value, old, current):
    if isinstance(value, str) and (value == str(old) or value.startswith(str(old) + os.sep)):
        return str(current) + value[len(str(old)):]
    return value


def update_pointers(home, old, record):
    paths = [(home / "run-index.json", "receiptPath"), (home / "settings.json", "runsDirectory")]
    paths += [(p, "registration") for p in (home / "projects").glob("*.json")]
    for path, kind in paths:
        if not path.exists():
            continue
        if path.is_symlink() or not path.is_file():
            raise RuntimeError("Refusing a non-file state pointer: " + str(path))
        value = json.loads(path.read_text())
        original = json.dumps(value, sort_keys=True)
        if kind == "receiptPath":
            # The index is a bounded array of pointers, not a receipt copy.
            for item in value["runs"]:
                item["receiptPath"] = migrated_path(item.get("receiptPath"), old, home)
        elif kind == "registration":
            for key in ("sourceRoot", "manifestPath"):
                value[key] = migrated_path(value.get(key), old, home)
        else:
            if "runsDirectory" in value:
                value["runsDirectory"] = migrated_path(value["runsDirectory"], old, home)
        if json.dumps(value, sort_keys=True) != original:
            atomic_bytes(path, (json.dumps(value, indent=2) + "\n").encode(), stat.S_IMODE(path.stat().st_mode))
    plist = old.parent / "Library/LaunchAgents/org.the-fleet.service.plist"
    if plist.exists():
        if plist.is_symlink():
            raise RuntimeError("Refusing a symlinked login-service configuration.")
        value = plistlib.loads(plist.read_bytes())
        if value.get("Label") != "org.the-fleet.service":
            raise RuntimeError("Unexpected login-service identity.")
        original = plistlib.dumps(value)
        env = value.get("EnvironmentVariables", {})
        for key in ("THE_FLEET_HOME", "FLEET_RUNNER_HOME"):
            if key in env:
                env[key] = migrated_path(env[key], old, home)
        for key in ("StandardOutPath", "StandardErrorPath"):
            if key in value:
                value[key] = migrated_path(value[key], old, home)
        if plistlib.dumps(value) != original:
            atomic_bytes(plist, plistlib.dumps(value), stat.S_IMODE(plist.stat().st_mode))


def migrate(parent, dry_run=False):
    old, current = parent / ".fleet-runner", parent / ".the-fleet"
    if old.is_symlink() or current.is_symlink():
        raise RuntimeError("Migration requires real state directories, not symlinks.")
    if old.exists() and current.exists():
        raise RuntimeError("Both state folders exist; migration refuses to merge or overwrite them.")
    record = None
    if current.exists():
        path = current / RECORD
        if not path.is_file():
            raise RuntimeError("Destination already exists without a migration record.")
        record = json.loads(path.read_text())
        if (record.get("schemaVersion") != 1 or record.get("source") != str(old)
                or record.get("destination") != str(current) or record.get("phase") not in ("prepared", "complete")):
            raise RuntimeError("Invalid migration record.")
        if record["phase"] == "complete":
            return {"state": "already-complete", "home": str(current)}
    elif not old.is_dir():
        raise RuntimeError("Legacy state directory does not exist.")
    if dry_run:
        return {"state": "planned", "source": str(old), "destination": str(current), "requiresStoppedService": True, "resuming": record is not None}
    with open(parent / ".the-fleet-migration.lock", "a+") as migration_guard:
        os.chmod(migration_guard.name, 0o600)
        fcntl.flock(migration_guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Recheck after locking; another migrator may have won the race.
        if old.exists() and current.exists():
            raise RuntimeError("Both state folders exist.")
        source = old if old.exists() else current
        if source.is_symlink() or not source.is_dir():
            raise RuntimeError("State directory changed during migration.")
        if source == current:
            record = json.loads((current / RECORD).read_text())
            if (record.get("schemaVersion") != 1 or record.get("source") != str(old)
                    or record.get("destination") != str(current) or record.get("phase") not in ("prepared", "complete")):
                raise RuntimeError("Invalid migration record.")
            if record["phase"] == "complete":
                return {"state": "already-complete", "home": str(current)}
        with open(source / "service.lock", "a+") as service_guard:
            os.chmod(service_guard.name, 0o600)
            fcntl.flock(service_guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if record is None:
                record = {"schemaVersion": 1, "source": str(old), "destination": str(current), "phase": "prepared"}
                # Journal before rename: interruption can be resumed from either name.
                if (old / RECORD).exists():
                    existing = json.loads((old / RECORD).read_text())
                    if existing != record:
                        raise RuntimeError("Unexpected legacy migration record.")
                else:
                    write_record(old / RECORD, record)
                os.rename(old, current)
            update_pointers(current, old, record)
            record["phase"] = "complete"
            write_record(current / RECORD, record)
    return {"state": "complete", "home": str(current)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--user-home", type=Path, default=Path.home())
    args = parser.parse_args()
    try:
        print(json.dumps(migrate(args.user_home.expanduser().absolute(), args.dry_run)))
    except (OSError, ValueError, RuntimeError) as error:
        print("The Fleet state was not fully migrated: " + str(error), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
