"""Pin an optional external work volume before running Fleet's existing scripts.

The client supplies the unchanged archive helper as source, so its native UUID,
device and free-space checks have one editable owner. Ethan's "build output on
the USB drive always" also keeps caches and private jobs on this volume. A
missing image or backing drive must fail before the normal scripts create any
folders. This is a short command wrapper, not a resident service. — GPT-6.1 Sol
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import subprocess
import sys
import types


def main() -> int:
    """Run with pinned mount descriptors; observations never mount or repair. — GPT-6.1 Sol"""
    root, mode, settings_text, helper_source, command = sys.argv[1:]
    settings = json.loads(settings_text)
    helper = types.ModuleType('fleet_work_volume_identity')
    sys.modules[helper.__name__] = helper
    exec(compile(helper_source, '<fleet archive volume owner>', 'exec'), helper.__dict__)
    Path(root).relative_to(settings['mountPoint'])
    if os.path.realpath(root) != root:
        raise ValueError('Large scratch needs its exact mounted-volume path.')
    pinned: list[int] = []
    try:
        volumes = [settings]
        if 'backingVolume' in settings:
            volumes.append({**settings['backingVolume'], 'minFreeGiB': settings['minFreeGiB']})
        for index, volume in enumerate(volumes):
            # A full disk must still allow status, cancellation and recovery.
            # Only admission needs the space reserve. Found and fixed by GPT-6.1 Sol.
            descriptor = helper.volume_fd(volume, 1 if mode == 'start' else 0)
            target = 198 - index
            os.dup2(descriptor, target, inheritable=True)
            if descriptor != target:
                os.close(descriptor)
            pinned.append(target)
        result = subprocess.run(['/bin/bash', '-c', command], pass_fds=tuple(pinned))
        if mode == 'observe' and result.returncode == 0:
            # A sparse image's apparent free space cannot exceed its physical
            # backing drive. The existing parser takes the final observation.
            spaces = [os.fstatvfs(descriptor) for descriptor in pinned]
            print('disk_free_kb=' + str(min(space.f_bavail * space.f_frsize for space in spaces) // 1024), flush=True)
        return result.returncode
    finally:
        for descriptor in pinned:
            os.close(descriptor)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print('fleet-runner: ' + str(error), file=sys.stderr)
        sys.exit(73)
