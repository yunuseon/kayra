"""Root/Linux filesystem tests: all writes stay in a new temporary directory."""
import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import signal
import stat
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts/server-lib"))
import registration_generation as storage

FIXTURE = json.loads((Path(__file__).with_name("fixture.json")).read_text())
GID = 65534


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "requires Linux root")
class GenerationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="kayra-platform-registration-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.root.chmod(0o755)
        self.fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.addCleanup(os.close, self.fd)
        self.fixture = copy.deepcopy(FIXTURE)
        self.meta = self.fixture["metadata"]
        self.key = hashlib.sha256(self.meta["app"].encode()).hexdigest()

    def publish(self, metadata=None, previous=None):
        return storage.publish(self.fd, metadata or self.meta, self.fixture["registration"], self.fixture["configuration"], self.fixture["secrets"], GID, previous)

    def path(self, private=False, generation=None):
        return self.root / ("private" if private else "public") / self.key / "generations" / (generation or self.meta["registrationGeneration"])

    def observation(self, metadata=None):
        return storage.observe(self.fd, metadata or self.meta, GID)

    def next_metadata(self, number=3):
        return {**self.meta, "registrationGeneration": f"{number:08x}-3333-4333-8333-333333333333", "actionId": self.meta["incarnation"] + f":{number - 1}"}

    def test_published_identity_and_private_access(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            self.publish()
            evidence = self.observation()
        self.assertEqual(evidence, self.fixture["evidence"])
        secret = self.path(True) / "secrets/DATABASE_PASSWORD"
        public = self.path() / "registration.json"
        self.assertEqual(secret.read_text(), self.fixture["secrets"]["DATABASE_PASSWORD"])
        self.assertEqual(stat.S_IMODE(secret.stat().st_mode), 0o440)
        self.assertEqual(secret.stat().st_uid, 0)
        self.assertEqual(secret.stat().st_gid, GID)
        self.assertEqual(stat.S_IMODE(self.path(True).stat().st_mode), 0o550)
        self.assertEqual(stat.S_IMODE(public.stat().st_mode), 0o444)
        for path in (self.root / "public").rglob("*"):
            if path.is_file():
                self.assertNotIn(self.fixture["secrets"]["DATABASE_PASSWORD"].encode(), path.read_bytes())
        self.assertNotIn(self.fixture["secrets"]["DATABASE_PASSWORD"], output.getvalue() + json.dumps(evidence))
        for gid, allowed in ((GID, True), (65533, False)):
            pid = os.fork()
            if pid == 0:
                try:
                    os.setgroups([])
                    os.setgid(gid)
                    os.setuid(65533)
                    public.read_bytes()
                    try:
                        secret.read_bytes()
                        if not allowed:
                            os._exit(1)
                        try:
                            secret.write_text("must not change")
                            os._exit(1)
                        except PermissionError:
                            os._exit(0)
                    except PermissionError:
                        os._exit(1 if allowed else 0)
                except BaseException:
                    os._exit(2)
            self.assertEqual(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]), 0)

    def test_observer_does_not_create_missing_storage(self):
        self.assertEqual(self.observation()["status"], "unknown")
        self.assertEqual(list(self.root.iterdir()), [])

    def test_pointer_guard_and_generation_collision_preserve_data(self):
        self.publish()
        before = (self.path() / "registration.json").read_bytes()
        with self.assertRaises(storage.RegistrationError):
            self.publish(previous=self.meta)
        self.assertEqual((self.path() / "registration.json").read_bytes(), before)
        following = self.next_metadata()
        with self.assertRaisesRegex(storage.RegistrationError, "pointer changed"):
            self.publish(following)
        self.assertFalse(self.path(generation=following["registrationGeneration"]).exists())
        self.publish(following, previous=self.meta)
        self.assertEqual(self.observation(following)["status"], "applied")
        self.assertEqual(self.observation()["status"], "not-applied")
        self.assertTrue(self.path().exists())

    def test_invalid_payloads_fail_before_filesystem_changes(self):
        for metadata in ({**self.meta, "app": "../escape"}, {**self.meta, "actionId": self.meta["incarnation"] + ":01"}, {**self.meta, "secret": "value"}):
            with self.assertRaises(storage.RegistrationError):
                self.publish(metadata)
        self.fixture["secrets"]["EXTRA"] = "value"
        with self.assertRaises(storage.RegistrationError):
            self.publish()
        self.assertEqual(list(self.root.iterdir()), [])

    def test_invalid_secret_encoding_and_oversized_keys_have_fixed_errors(self):
        self.fixture["secrets"]["DATABASE_PASSWORD"] = "synthetic-secret-\ud800"
        with self.assertRaisesRegex(storage.RegistrationError, "^invalid registration value encoding$"):
            self.publish()
        self.fixture = copy.deepcopy(FIXTURE)
        self.fixture["configuration"]["A" * 129] = "value"
        with self.assertRaises(storage.RegistrationError):
            self.publish()
        self.assertEqual(list(self.root.iterdir()), [])

    def test_repository_credentials_and_stale_action_are_refused(self):
        for repo in ("https://user:synthetic-password@example.invalid/owner/app.git", "ssh://git:synthetic-password@example.invalid/owner/app.git", "https://example.invalid:99999/app.git"):
            self.fixture["registration"]["repo"] = repo
            with self.assertRaises(storage.RegistrationError):
                self.publish()
        self.assertEqual(list(self.root.iterdir()), [])
        self.fixture = copy.deepcopy(FIXTURE)
        self.publish()
        following = self.next_metadata()
        with self.assertRaisesRegex(storage.RegistrationError, "action did not advance"):
            self.publish({**following, "actionId": self.meta["actionId"]}, self.meta)
        self.assertFalse(self.path(generation=following["registrationGeneration"]).exists())

    def test_pointer_for_another_app_is_unknown(self):
        self.publish()
        pointer = self.root / "public" / self.key / "current.json"
        pointer.write_text(json.dumps({**self.meta, "app": "other"}))
        self.assertEqual(self.observation()["status"], "unknown")

    def test_unknown_on_missing_files_wrong_modes_hardlinks_or_symlinks(self):
        self.publish()
        secret = self.path(True) / "secrets/DATABASE_PASSWORD"
        secret.chmod(0o400)
        self.assertEqual(self.observation()["status"], "unknown")
        secret.chmod(0o440)
        linked = self.root / "linked-secret"
        os.link(secret, linked)
        self.assertEqual(self.observation()["status"], "unknown")
        linked.unlink()
        original = secret.read_bytes()
        secret.unlink()
        outside = self.root / "outside"
        outside.write_bytes(original)
        secret.symlink_to(outside)
        self.assertEqual(self.observation()["status"], "unknown")
        self.assertEqual(outside.read_bytes(), original)
        secret.unlink()
        self.assertEqual(self.observation()["status"], "unknown")

    def test_symlink_parent_and_pointer_are_never_followed(self):
        outside = self.root / "outside"
        outside.mkdir()
        (self.root / "public").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(storage.RegistrationError):
            self.publish()
        self.assertEqual(list(outside.iterdir()), [])
        (self.root / "public").unlink()
        self.publish()
        pointer = self.root / "public" / self.key / "current.json"
        pointer.unlink()
        sentinel = outside / "sentinel"
        sentinel.write_text("unchanged")
        pointer.symlink_to(sentinel)
        self.assertEqual(self.observation()["status"], "unknown")
        with self.assertRaises(storage.RegistrationError):
            self.publish(self.next_metadata(), self.meta)
        self.assertEqual(sentinel.read_text(), "unchanged")

    def test_sync_and_rename_uncertainty_remain_recoverable(self):
        self.publish()
        following = self.next_metadata()
        actual = storage.os.replace
        def replace_then_fail(*args, **kwargs):
            actual(*args, **kwargs)
            raise OSError("lost acknowledgement")
        with mock.patch.object(storage.os, "replace", side_effect=replace_then_fail):
            with self.assertRaisesRegex(storage.RegistrationError, "uncertain"):
                self.publish(following, self.meta)
        self.assertEqual(self.observation(following)["status"], "applied")
        with mock.patch.object(storage.os, "fsync", side_effect=OSError("sync failed")):
            self.assertEqual(self.observation(following)["status"], "unknown")
        self.assertEqual(self.observation(following)["status"], "applied")

    def test_failed_generation_sync_preserves_partial_data_without_publishing_it(self):
        self.publish()
        following = self.next_metadata()
        actual_sync = storage.os.fsync
        def fail_configuration_sync(fd):
            if os.readlink(f"/proc/self/fd/{fd}").endswith("/configuration.json"):
                raise OSError("injected sync failure")
            return actual_sync(fd)
        with mock.patch.object(storage.os, "fsync", side_effect=fail_configuration_sync):
            with self.assertRaisesRegex(storage.RegistrationError, "uncertain"):
                self.publish(following, self.meta)
        self.assertEqual(self.observation()["status"], "applied")
        self.assertEqual(self.observation(following)["status"], "not-applied")
        self.assertTrue(self.path(True, following["registrationGeneration"]).exists())
        with self.assertRaises(storage.RegistrationError):
            self.publish(following, self.meta)
        self.assertEqual(self.observation()["status"], "applied")

    def test_nonregular_secret_and_wrong_owner_are_unknown(self):
        self.publish()
        secret = self.path(True) / "secrets/DATABASE_PASSWORD"
        os.chown(secret, 65533, GID)
        self.assertEqual(self.observation()["status"], "unknown")
        secret.unlink()
        os.mkfifo(secret, 0o440)
        self.assertEqual(self.observation()["status"], "unknown")

    def test_kill_before_and_after_pointer_preserves_old_or_new_generation(self):
        self.publish()
        for number, after in ((3, False), (4, True)):
            following = self.next_metadata(number)
            read_fd, write_fd = os.pipe()
            pid = os.fork()
            if pid == 0:
                os.close(read_fd)
                actual = storage.os.replace
                def pause(*args, **kwargs):
                    if after:
                        actual(*args, **kwargs)
                    os.write(write_fd, b"r")
                    os.kill(os.getpid(), signal.SIGSTOP)
                try:
                    with mock.patch.object(storage.os, "replace", side_effect=pause):
                        self.publish(following, self.meta)
                finally:
                    os._exit(3)
            os.close(write_fd)
            try:
                self.assertEqual(os.read(read_fd, 1), b"r")
            finally:
                os.close(read_fd)
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            self.assertEqual(self.observation(following if after else self.meta)["status"], "applied")
            self.assertTrue(self.path(True, following["registrationGeneration"]).exists())

    def test_concurrent_publishers_are_ordered_by_pointer_precondition(self):
        self.publish()
        children = []
        for number in (3, 4):
            pid = os.fork()
            if pid == 0:
                try:
                    self.publish(self.next_metadata(number), self.meta)
                    os._exit(0)
                except storage.RegistrationError:
                    os._exit(2)
                except BaseException:
                    os._exit(3)
            children.append(pid)
        statuses = sorted(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]) for pid in children)
        self.assertEqual(statuses, [0, 2])
        observed = [self.observation(self.next_metadata(number))["status"] for number in (3, 4)]
        self.assertEqual(sorted(observed), ["applied", "not-applied"])


if __name__ == "__main__":
    if sys.platform != "linux" or os.geteuid() != 0:
        raise SystemExit("registration storage tests require Linux root")
    unittest.main(verbosity=2)
