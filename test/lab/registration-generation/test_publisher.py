#!/usr/bin/env python3
"""Linux-only filesystem tests; every effect is under a fresh temp directory."""
import contextlib
import io
import json
import os
import pathlib
import signal
import stat
import sys
import tempfile
import unittest
from unittest import mock

import publisher

ID1 = "11111111-1111-4111-8111-111111111111"
ID2 = "22222222-2222-4222-8222-222222222222"
SECRET = "SYNTHETIC-LAB-SECRET-61a58"


@unittest.skipUnless(sys.platform == "linux", "Linux filesystem semantics required")
class PublisherTest(unittest.TestCase):
    def setUp(self):
        old_umask = os.umask(0o022)
        self.addCleanup(os.umask, old_umask)
        self.temp = tempfile.TemporaryDirectory(prefix="kayra-registration-generation-")
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.root.chmod(0o755)
        self.fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.addCleanup(os.close, self.fd)
        publisher.bootstrap(self.fd)

    def publish(self, generation=ID1, checkpoint=lambda _: None):
        publisher.publish(self.fd, generation, {"name": "shop", "hosts": ["app.invalid"]}, {"password": SECRET}, checkpoint)

    def current(self):
        return json.loads((self.root / "public/current.json").read_text())["generation"]

    def test_visibility_permissions_and_independent_generations(self):
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            self.publish()
            self.publish(ID2)
        self.assertNotIn(SECRET, captured.getvalue())
        self.assertEqual(self.current(), ID2)
        private = self.root / "private/generations" / ID1 / "secrets.json"
        public = self.root / "public/generations" / ID1 / "registration.json"
        self.assertEqual(stat.S_IMODE(private.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(public.stat().st_mode), 0o644)
        self.assertEqual(stat.S_IMODE((self.root / "private").stat().st_mode), 0o700)
        self.assertEqual(private.stat().st_uid, os.geteuid())
        for path in (self.root / "public").rglob("*"):
            if path.is_file():
                self.assertNotIn(SECRET.encode(), path.read_bytes())
        if os.geteuid() == 0:
            pid = os.fork()
            if pid == 0:
                try:
                    os.setgroups([])
                    os.setgid(65534)
                    os.setuid(65534)
                    public.read_bytes()
                    try:
                        private.read_bytes()
                    except PermissionError:
                        os._exit(0)
                    os._exit(1)
                except BaseException:
                    os._exit(2)
            _, status = os.waitpid(pid, 0)
            self.assertEqual(os.waitstatus_to_exitcode(status), 0)

    def test_generation_and_pointer_staging_collisions_do_not_overwrite(self):
        self.publish()
        public = self.root / "public/generations" / ID1 / "registration.json"
        before = public.read_bytes()
        with self.assertRaises(FileExistsError):
            self.publish()
        self.assertEqual(public.read_bytes(), before)
        self.assertEqual(self.current(), ID1)
        temp = self.root / "public" / f".current-{ID2}.tmp"
        temp.write_text("unrelated")
        with self.assertRaises(FileExistsError):
            self.publish(ID2)
        self.assertEqual(temp.read_text(), "unrelated")
        self.assertFalse((self.root / "public/generations" / ID2).exists())
        self.assertFalse((self.root / "private/generations" / ID2).exists())
        self.assertEqual(self.current(), ID1)

    def test_failures_before_and_after_pointer_preserve_consistent_references(self):
        self.publish()
        for point in ("private", "public", "before-pointer"):
            with self.subTest(point=point):
                def fail(name):
                    if name == point:
                        raise RuntimeError("injected failure")
                with self.assertRaisesRegex(RuntimeError, "injected failure"):
                    self.publish(ID2, fail)
                self.assertEqual(self.current(), ID1)
                self.assertFalse((self.root / "public/generations" / ID2).exists())
                self.assertFalse((self.root / "private/generations" / ID2).exists())
        def after(name):
            if name == "after-pointer":
                raise RuntimeError("uncertain publication")
        with self.assertRaisesRegex(RuntimeError, "uncertain publication"):
            self.publish(ID2, after)
        self.assertEqual(self.current(), ID2)
        self.assertTrue((self.root / "public/generations" / ID2 / "registration.json").is_file())
        self.assertTrue((self.root / "private/generations" / ID2 / "secrets.json").is_file())

    def test_sigkill_before_and_after_pointer_preserves_referenced_generations(self):
        self.publish()
        for index, point in enumerate(("private", "public", "before-pointer", "after-pointer"), 2):
            generation = f"{index:08x}-2222-4222-8222-222222222222"
            read_fd, write_fd = os.pipe()
            pid = os.fork()
            if pid == 0:
                os.close(read_fd)
                def pause(name):
                    if name == point:
                        os.write(write_fd, b"r")
                        os.kill(os.getpid(), signal.SIGSTOP)
                try:
                    self.publish(generation, pause)
                finally:
                    os._exit(3)
            os.close(write_fd)
            try:
                self.assertEqual(os.read(read_fd, 1), b"r")
            finally:
                os.close(read_fd)
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            current = self.current()
            self.assertEqual(current, generation if point == "after-pointer" else ID1)
            self.assertTrue((self.root / "public/generations" / current / "registration.json").is_file())
            self.assertTrue((self.root / "private/generations" / current / "secrets.json").is_file())
            self.assertTrue((self.root / "private/generations" / generation).is_dir())

    def test_lost_rename_acknowledgement_keeps_possibly_published_generation(self):
        self.publish()
        actual_replace = publisher.os.replace
        def rename_then_fail(*args, **kwargs):
            actual_replace(*args, **kwargs)
            raise OSError("injected lost rename acknowledgement")
        with mock.patch.object(publisher.os, "replace", side_effect=rename_then_fail):
            with self.assertRaisesRegex(OSError, "lost rename acknowledgement"):
                self.publish(ID2)
        self.assertEqual(self.current(), ID2)
        self.assertTrue((self.root / "public/generations" / ID2 / "registration.json").is_file())
        self.assertTrue((self.root / "private/generations" / ID2 / "secrets.json").is_file())

    def test_symlinks_are_not_followed_in_parent_or_final_generation(self):
        outside = self.root / "outside"
        outside.mkdir()
        keep = outside / "keep"
        keep.write_text("untouched")
        private_generations = self.root / "private/generations"
        private_generations.rmdir()
        private_generations.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(OSError):
            self.publish()
        self.assertEqual(keep.read_text(), "untouched")
        private_generations.unlink()
        private_generations.mkdir(mode=0o700)
        (private_generations / ID1).symlink_to(outside, target_is_directory=True)
        with self.assertRaises(FileExistsError):
            self.publish()
        self.assertEqual(keep.read_text(), "untouched")
        self.assertEqual(list(outside.iterdir()), [keep])

    def test_failed_file_write_cleans_only_its_own_staging(self):
        with mock.patch.object(publisher.os, "write", side_effect=OSError("injected I/O failure")):
            with self.assertRaisesRegex(OSError, "injected I/O failure"):
                self.publish()
        self.assertFalse((self.root / "private/generations" / ID1).exists())
        self.assertFalse((self.root / "public/generations" / ID1).exists())
        self.assertFalse((self.root / "public/current.json").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
