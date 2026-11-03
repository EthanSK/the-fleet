"""Exercise the deployed archive helper with real files/tar and mocked devices.

Only the volume-observation boundary is mocked; real volume qualification is
separate. Tests never mount, write to, or alter an actual external drive.
"""
import importlib.util
import contextlib
import io
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('fleet_scratch_fixture', sys.argv.pop(1))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
real_volume_fd = helper.volume_fd


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='fleet-archive-')
        self.root = Path(self.temporary.name).resolve()
        self.mount = self.root / 'mounted'
        self.mount.mkdir()
        self.job = self.root / 'jobs/example-job'
        (self.job / 'meta').mkdir(parents=True)
        (self.job / 'src').mkdir()
        (self.job / '.fleet-job').write_text('')
        self.cfg = {'mountPoint': str(self.mount), 'volumeUuid': '00000000-0000-4000-8000-000000000001', 'directory': 'AgentScratch.noindex/the-fleet', 'minFileMiB': 1, 'minFreeGiB': 0}
        (self.job / 'meta/large-scratch.json').write_text(json.dumps(self.cfg))
        self.payload = b'a' * 1048576
        (self.job / 'src/payload.bin').write_bytes(self.payload)
        self.volume = patch.object(helper, 'volume_fd', side_effect=lambda cfg, required_bytes=0: os.open(self.mount, helper.DIRECTORY))
        self.volume.start()

    def tearDown(self):
        self.volume.stop()
        self.temporary.cleanup()

    def capture(self, maximum=2 * 1048576):
        with helper.archive_guard(self.job) as guard:
            helper.capture(self.job, len(self.payload), maximum, ['./payload.bin'], guard)
        return json.loads(helper.owner_file(self.job).read_text())

    def folder(self, value):
        return self.mount / self.cfg['directory'] / value['folder']

    def test_real_tar_return_and_ack_cleanup(self):
        value = self.capture()
        folder = self.folder(value)
        self.assertFalse((self.job / 'artifacts.tar').exists())
        with helper.open_archive(self.job) as source:
            with tarfile.open(fileobj=io.BytesIO(source.read())) as archive:
                self.assertEqual(archive.extractfile('./payload.bin').read(), self.payload)
        (self.job / 'artifacts.pending').write_text('')
        helper.cleanup_archive(self.job)
        self.assertTrue((folder / 'artifacts.tar').exists())
        helper.cleanup_archive(self.job, acknowledged=True)
        self.assertFalse(folder.exists())
        self.assertFalse(helper.owner_file(self.job).exists())

    def test_unknown_entries_and_mismatched_ownership_are_retained(self):
        value = self.capture()
        folder = self.folder(value)
        (folder / 'personal.txt').write_text('keep')
        with self.assertRaises(ValueError):
            helper.cleanup_archive(self.job)
        self.assertEqual((folder / 'personal.txt').read_text(), 'keep')
        (folder / 'personal.txt').unlink()
        (folder / helper.OWNER_MARKER).write_text(json.dumps({'job': 'another job'}))
        with self.assertRaises(ValueError):
            helper.cleanup_archive(self.job)
        self.assertTrue((folder / 'artifacts.tar').exists())

    def test_symlink_and_foreign_root_are_never_adopted(self):
        base = self.mount / 'AgentScratch.noindex'
        base.mkdir()
        other = self.root / 'personal'
        other.mkdir()
        (base / 'the-fleet').symlink_to(other, target_is_directory=True)
        with self.assertRaises(OSError):
            self.capture()
        self.assertEqual(list(other.iterdir()), [])
        (base / 'the-fleet').unlink()
        (base / 'the-fleet').mkdir()
        (base / 'the-fleet/personal.txt').write_text('keep')
        with self.assertRaises(ValueError):
            self.capture()
        self.assertEqual((base / 'the-fleet/personal.txt').read_text(), 'keep')

    def test_tar_file_limit_leaves_owned_partial_for_safe_cleanup(self):
        (self.job / 'src/payload.bin').write_bytes(self.payload * 3)
        with self.assertRaises(subprocess.CalledProcessError):
            self.capture(maximum=2 * 1048576)
        value = helper.load_owner(self.job)
        self.assertLessEqual((self.folder(value) / 'artifacts.tar.part').stat().st_size, 2 * 1048576)
        helper.cleanup_archive(self.job)
        self.assertFalse(self.folder(value).exists())

    def test_lost_volume_cannot_be_read_or_deleted_by_path_fallback(self):
        value = self.capture()
        with patch.object(helper, 'volume_fd', side_effect=ValueError('changed volume')):
            with self.assertRaises(ValueError):
                helper.open_archive(self.job)
            with self.assertRaises(ValueError):
                helper.cleanup_archive(self.job)
        self.assertTrue((self.folder(value) / 'artifacts.tar').exists())

    def test_archive_guard_exposes_an_active_writer(self):
        with helper.archive_guard(self.job):
            with self.assertRaises(BlockingIOError):
                with helper.archive_guard(self.job):
                    self.fail('another archive operation acquired ownership')

    def test_concurrent_jobs_get_distinct_owned_folders_and_cannot_clean_each_other(self):
        jobs = [self.root / 'jobs' / ('parallel-' + str(index)) for index in range(2)]
        for job in jobs:
            (job / 'meta').mkdir(parents=True)
            (job / '.fleet-job').write_text('')
            (job / 'meta/large-scratch.json').write_text(json.dumps(self.cfg))
        def allocate(job):
            base, folder, value = helper.open_store(job, create=True)
            os.close(folder)
            os.close(base)
            return value
        with ThreadPoolExecutor(max_workers=2) as pool:
            values = list(pool.map(allocate, jobs))
        self.assertNotEqual(values[0]['folder'], values[1]['folder'])
        helper.cleanup_archive(jobs[0])
        self.assertTrue(self.folder(values[1]).is_dir())
        helper.cleanup_archive(jobs[1])
        self.assertFalse(self.folder(values[1]).exists())

    def device_check(self, uuid=None, mounted=True, free=10 ** 9):
        original_stat = os.stat
        device = original_stat(self.mount).st_dev
        def observed_stat(path, *args, **kwargs):
            return SimpleNamespace(st_rdev=device) if path == '/fixture/device' else original_stat(path, *args, **kwargs)
        info = {'MountPoint': str(self.mount), 'VolumeUUID': uuid or self.cfg['volumeUuid'], 'DeviceNode': '/fixture/device'}
        with patch.object(helper.sys, 'platform', 'darwin'), patch.object(helper.os.path, 'ismount', return_value=mounted), patch.object(helper.subprocess, 'run', return_value=SimpleNamespace(stdout=plistlib.dumps(info))), patch.object(helper.os, 'stat', side_effect=observed_stat), patch.object(helper.os, 'fstatvfs', return_value=SimpleNamespace(f_bavail=free, f_frsize=1)):
            return real_volume_fd(self.cfg, 1048576)

    def test_volume_uuid_mount_and_free_space_are_checked_before_creation(self):
        for options in ({'uuid': 'different'}, {'mounted': False}, {'free': 0}):
            with self.assertRaises(ValueError):
                self.device_check(**options)
            self.assertFalse((self.mount / 'AgentScratch.noindex').exists())
        self.cfg['minFreeGiB'] = 2
        with self.assertRaises(ValueError):
            self.device_check(free=1024 ** 3)
        fd = self.device_check(free=4 * 1024 ** 3)
        self.assertEqual(os.fstat(fd).st_dev, self.mount.stat().st_dev)
        os.close(fd)

    def test_linux_uuid_device_is_bound_to_the_open_mount(self):
        device = SimpleNamespace(name=self.cfg['volumeUuid'], stat=lambda: SimpleNamespace(st_rdev=self.mount.stat().st_dev))
        with patch.object(helper.sys, 'platform', 'linux'), patch.object(helper.os.path, 'ismount', return_value=True), patch.object(helper.Path, 'iterdir', return_value=iter([device])):
            fd = real_volume_fd(self.cfg)
            self.assertEqual(os.fstat(fd).st_dev, self.mount.stat().st_dev)
            os.close(fd)

    def test_archive_symlink_is_neither_read_nor_deleted(self):
        value = self.capture()
        folder = self.folder(value)
        (folder / 'artifacts.tar').unlink()
        outside = self.root / 'personal.txt'
        outside.write_text('keep')
        (folder / 'artifacts.tar').symlink_to(outside)
        with self.assertRaises(ValueError):
            helper.open_archive(self.job)
        with self.assertRaises(ValueError):
            helper.cleanup_archive(self.job)
        self.assertEqual(outside.read_text(), 'keep')

    def test_long_job_ids_keep_bounded_owned_folder_names(self):
        long_job = self.root / 'jobs' / ('long-' + 'x' * 180)
        self.job.rename(long_job)
        self.job = long_job
        value = self.capture()
        self.assertLessEqual(len(value['folder'].encode()), 255)
        helper.cleanup_archive(self.job)
        self.assertFalse(self.folder(value).exists())

    def test_external_failure_is_classified_even_when_retention_marker_cannot_be_written(self):
        with patch.object(helper.sys, 'argv', ['archive', 'capture', str(self.job), str(len(self.payload)), str(2 * 1048576), './payload.bin']), patch.object(helper.Path, 'write_text', side_effect=PermissionError('metadata is read-only')):
            with self.assertRaises(SystemExit) as result:
                helper.main()
        self.assertEqual(result.exception.code, 73)
        self.assertTrue((self.job / 'src/payload.bin').exists())
        self.assertFalse(helper.owner_file(self.job).exists())

    def test_cli_free_space_refusal_has_a_specific_machine_readable_cause(self):
        output = io.StringIO()
        with patch.object(helper.sys, 'argv', ['archive', 'capture', str(self.job), str(len(self.payload)), str(2 * 1048576), './payload.bin']), patch.object(helper, 'volume_fd', side_effect=helper.InsufficientScratchSpace('The large scratch volume has insufficient free space.')), contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as result:
                helper.main()
        self.assertEqual(result.exception.code, 75)
        self.assertEqual(json.loads(output.getvalue()), {'phase': 'archive', 'message': 'The large scratch volume has insufficient free space.'})
        self.assertTrue((self.job / 'meta/large-scratch-failed').exists())
        self.assertTrue((self.job / 'src/payload.bin').exists())

    def test_cli_normal_usb_capture_emits_no_disk_problem(self):
        output = io.StringIO()
        with patch.object(helper.sys, 'argv', ['archive', 'capture', str(self.job), str(len(self.payload)), str(2 * 1048576), './payload.bin']), contextlib.redirect_stdout(output):
            helper.main()
        self.assertEqual(output.getvalue().strip(), 'external')

    def test_cleanup_retries_bookkeeping_after_the_owned_directory_is_already_removed(self):
        value = self.capture()
        real_unlink = Path.unlink
        def unlink(path, *args, **kwargs):
            if path == helper.owner_file(self.job):
                raise PermissionError('metadata is read-only')
            return real_unlink(path, *args, **kwargs)
        with patch.object(helper.Path, 'unlink', side_effect=unlink, autospec=True):
            with self.assertRaises(PermissionError):
                helper.cleanup_archive(self.job)
        self.assertFalse(self.folder(value).exists())
        self.assertTrue(helper.owner_file(self.job).exists())
        helper.cleanup_archive(self.job)
        self.assertFalse(helper.owner_file(self.job).exists())


if __name__ == '__main__':
    unittest.main()
