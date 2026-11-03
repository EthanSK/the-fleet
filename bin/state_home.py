"""State-home discovery shared by the kernel launcher and explicit migrator."""
import json
from pathlib import Path

RECORD = "state-migration.json"


def resolve_home(requested=None, user_home=None):
    user_home = Path(user_home or Path.home())
    old, current = user_home / ".fleet-runner", user_home / ".the-fleet"
    selected = Path(requested).expanduser().absolute() if requested else None
    if selected not in (None, old, current):
        return selected
    migrated = False
    if (old / RECORD).exists() and not current.exists():
        raise RuntimeError("The Fleet state migration is incomplete. Run the-fleet migrate-home again.")
    record = current / RECORD
    if record.exists():
        value = json.loads(record.read_text())
        if (value.get("schemaVersion") != 1 or value.get("source") != str(old)
                or value.get("destination") != str(current) or value.get("phase") != "complete"):
            raise RuntimeError("The Fleet state migration is incomplete. Run the-fleet migrate-home again.")
        migrated = True
    if old.exists() and current.exists():
        if not (migrated and old.is_symlink() and old.resolve() == current.resolve()):
            raise RuntimeError("Both .fleet-runner and .the-fleet exist. Resolve the conflicting state folders before starting The Fleet.")
    if selected == current and old.exists() and not current.exists():
        raise RuntimeError("Migrate the existing .fleet-runner folder before selecting .the-fleet.")
    if selected == old and current.exists() and not migrated:
        raise RuntimeError("The requested legacy folder has no migration record. Use the existing .the-fleet folder.")
    if migrated or selected == current or current.exists():
        return current
    if old.exists():
        return old
    return selected or current
