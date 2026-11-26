"""Root/Linux filesystem tests: all writes stay in a new temporary directory."""
import contextlib
import copy
import fcntl
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
import registration_command as command

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

    def test_initial_staging_is_private_and_binds_exact_payload(self):
        app = self.meta["app"]

        def stage():
            return storage.stage_initial_registration(self.fd, app, self.fixture["registration"], self.fixture["configuration"], self.fixture["secrets"])

        replace = os.replace

        def replace_then_fail(*args, **kwargs):
            replace(*args, **kwargs)
            raise OSError("lost acknowledgement")

        with mock.patch.object(storage.os, "replace", side_effect=replace_then_fail):
            with self.assertRaisesRegex(storage.RegistrationError, "staging uncertain"):
                stage()
        generation = stage()
        self.assertEqual(stage(), generation)
        request = self.root / "initial-requests" / self.key / "request.json"
        self.assertEqual(stat.S_IMODE(request.stat().st_mode), 0o400)
        self.assertEqual(stat.S_IMODE(request.parent.stat().st_mode), 0o700)
        self.assertFalse((self.root / "public").exists())
        with self.assertRaisesRegex(storage.RegistrationError, "generation conflict"):
            storage.publish_staged_initial_registration(self.fd, self.next_metadata(), GID)
        self.fixture["secrets"]["DATABASE_PASSWORD"] = "changed"
        with self.assertRaisesRegex(storage.RegistrationError, "payload conflict"):
            stage()
        metadata = {**self.meta, "registrationGeneration": generation}
        storage.publish_staged_initial_registration(self.fd, metadata, GID)
        self.assertEqual(self.observation(metadata)["status"], "applied")
        secret = self.path(True, generation) / "secrets/DATABASE_PASSWORD"
        self.assertEqual(secret.read_text(), FIXTURE["secrets"]["DATABASE_PASSWORD"])

    def test_only_verified_publication_creates_root_owned_evidence(self):
        evidence_root = self.root / "observations"
        result = storage.record_publication_evidence(self.fd, self.meta, GID)
        self.assertEqual(result["status"], "unknown")
        self.assertFalse(evidence_root.exists())
        self.publish()
        wrong = storage.record_publication_evidence(self.fd, self.next_metadata(), GID)
        self.assertEqual(wrong["status"], "not-applied")
        self.assertFalse(evidence_root.exists())
        result = storage.record_publication_evidence(self.fd, self.meta, GID)
        path = evidence_root / self.key / (self.meta["registrationGeneration"] + ".json")
        self.assertEqual(json.loads(path.read_text()), result)
        self.assertEqual(result, self.fixture["evidence"])
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o444)
        self.assertEqual(path.stat().st_uid, 0)
        self.assertEqual(path.stat().st_gid, 0)

    def test_host_flow_reuses_generation_after_lost_reconcile_reply(self):
        request = {key: self.fixture[key] for key in ("registration", "configuration", "secrets")}
        request["app"] = self.meta["app"]
        ticket = self.meta["actionId"]
        generations = set()

        def control(operation, app, generation, *tickets):
            self.assertEqual(app, self.meta["app"])
            generations.add(generation)
            if operation == "reserve":
                return {"incarnation": self.meta["incarnation"], "ticket": ticket}
            self.assertEqual(tickets, (ticket,))
            if operation == "submit":
                return {"status": "reconcile", "actionId": ticket}
            self.assertEqual(operation, "reconcile")
            return {"status": "pending"}

        with self.assertRaisesRegex(storage.RegistrationError, "receipt remains unresolved"):
            command.register(self.fd, GID, request, control)
        generation, = generations
        private = self.path(True, generation)
        first_inode = private.stat().st_ino

        def retry(operation, *args):
            reply = control(operation, *args)
            return {"status": "verified"} if operation == "reconcile" else reply

        self.assertEqual(command.register(self.fd, GID, request, retry), {"status": "verified"})
        self.assertEqual(generations, {generation})
        self.assertEqual(private.stat().st_ino, first_inode)

    def test_experimental_claim_refuses_legacy_state_and_survives_reopen(self):
        app = self.meta["app"]
        for name in ("apps", "removing", "removal-locks", "managed-apps"):
            (self.root / name).mkdir(mode=0o755 if name == "managed-apps" else 0o700)
        marker = self.root / "managed-apps" / (app + ".json")
        legacy = self.root / "apps" / (app + ".json")
        legacy.touch()
        with self.assertRaisesRegex(storage.RegistrationError, "legacy Compose state"):
            with command.claim_experimental_app(self.root, app, lambda _: False):
                self.fail("legacy app was claimed")
        self.assertFalse(marker.exists())
        legacy.unlink()

        with self.assertRaisesRegex(storage.RegistrationError, "legacy Compose state"):
            with command.claim_experimental_app(self.root, app, lambda _: True):
                self.fail("legacy volume was ignored")
        self.assertFalse(marker.exists())

        lock = self.root / "removal-locks" / (app + ".lock")
        with lock.open("w") as holder:
            fcntl.flock(holder, fcntl.LOCK_EX)
            with self.assertRaisesRegex(storage.RegistrationError, "holds the app lock"):
                with command.claim_experimental_app(self.root, app, lambda _: False):
                    self.fail("contended app was claimed")
        self.assertFalse(marker.exists())

        with self.assertRaisesRegex(RuntimeError, "lost registration caller"):
            with command.claim_experimental_app(self.root, app, lambda _: False):
                self.assertEqual(stat.S_IMODE(marker.stat().st_mode), 0o444)
                raise RuntimeError("lost registration caller")
        inode = marker.stat().st_ino
        with command.claim_experimental_app(self.root, app, lambda _: False):
            self.assertEqual(marker.stat().st_ino, inode)

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

    def swarm_registration(self):
        self.meta["app"] = "swarm-fixture"
        self.fixture["registration"] = {**self.fixture["registration"], "name": "swarm-fixture", "runtime": "swarm",
                                        "grants": {"memory_bytes": 268435456, "cpu_millicores": 500, "maintenance": False}}
        self.key = hashlib.sha256(self.meta["app"].encode()).hexdigest()
        return self.fixture["registration"]

    def ownership(self, metadata=None):
        reference = json.loads((Path(__file__).with_name("ownership.json")).read_text())
        reference["registration"] = dict(metadata or self.meta)
        reference["ownership"].update(app=self.meta["app"], incarnation=self.meta["incarnation"])
        return reference

    def infrastructure(self, metadata=None):
        reference = json.loads(Path(__file__).with_name("infrastructure.json").read_text())
        reference.update(self.ownership(metadata))
        reference["overlay"]["scope"].update(app=self.meta["app"], incarnation=self.meta["incarnation"], name="kayra-app-" + self.meta["incarnation"])
        return reference

    def test_infrastructure_publication_matches_owner_and_pins_physical_grant(self):
        self.swarm_registration()
        owner, infrastructure = self.ownership(), self.infrastructure()
        storage.publish(self.fd, self.meta, self.fixture["registration"], self.fixture["configuration"], self.fixture["secrets"], GID, ownership=owner, infrastructure=infrastructure)
        path = self.path() / "infrastructure.json"
        self.assertEqual(json.loads(path.read_text()), infrastructure)
        self.assertEqual((stat.S_IMODE(path.stat().st_mode), path.stat().st_uid, path.stat().st_gid), (0o444, 0, 0))
        self.assertEqual(storage.observe(self.fd, self.meta, GID, owner, infrastructure)["status"], "applied")
        changed = copy.deepcopy(infrastructure)
        changed["overlay"]["id"] = "z" * 25
        self.assertEqual(storage.observe(self.fd, self.meta, GID, owner, changed)["status"], "unknown")
        path.unlink()
        self.assertEqual(storage.observe(self.fd, self.meta, GID, owner, infrastructure)["status"], "unknown")
        self.assertEqual(self.observation()["status"], "applied")

    def test_infrastructure_rejects_mismatched_scope_before_any_publication(self):
        self.swarm_registration()
        owner, infrastructure = self.ownership(), self.infrastructure()
        invalid = [{**infrastructure, "authority": True}, {**infrastructure, "runtime": "compose"}]
        for field, value in (("app", "foreign"), ("incarnation", "44444444-4444-4444-8444-444444444444"), ("name", "platform-swarm"), ("cluster", "invalid")):
            invalid.append({**infrastructure, "overlay": {**infrastructure["overlay"], "scope": {**infrastructure["overlay"]["scope"], field: value}}})
        invalid.append({**infrastructure, "overlay": {**infrastructure["overlay"], "id": "invalid"}})
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(storage.RegistrationError):
                storage.publish(self.fd, self.meta, self.fixture["registration"], self.fixture["configuration"], self.fixture["secrets"], GID, ownership=owner, infrastructure=value)
        with self.assertRaises(storage.RegistrationError):
            storage.publish(self.fd, self.meta, self.fixture["registration"], self.fixture["configuration"], self.fixture["secrets"], GID, infrastructure=infrastructure)
        self.assertFalse((self.root / "public").exists())

    def test_ownership_publication_is_bound_immutable_and_required_on_retry(self):
        self.swarm_registration()
        owner = self.ownership()
        storage.publish(self.fd, self.meta, self.fixture["registration"], self.fixture["configuration"], self.fixture["secrets"], GID, ownership=owner)
        path = self.path() / "ownership.json"
        self.assertEqual(json.loads(path.read_text()), owner)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o444)
        self.assertEqual((path.stat().st_uid, path.stat().st_gid), (0, 0))
        self.assertEqual(storage.observe(self.fd, self.meta, GID, owner)["status"], "applied")
        changed = copy.deepcopy(owner)
        changed["ownership"]["dataOwner"] = "44444444-4444-4444-8444-444444444444"
        self.assertEqual(storage.observe(self.fd, self.meta, GID, changed)["status"], "unknown")
        path.unlink()
        self.assertEqual(storage.observe(self.fd, self.meta, GID, owner)["status"], "unknown")
        self.assertEqual(self.observation()["status"], "applied")  # Old generations remain readable, without inferred ownership.

    def test_withdrawal_reconciles_after_unlink_and_fences_publication(self):
        self.swarm_registration()
        owner = self.ownership()
        storage.publish(self.fd, self.meta, self.fixture["registration"], self.fixture["configuration"],
                        self.fixture["secrets"], GID, ownership=owner)
        requested = {"version": 1, "request": "12345678-1111-4111-8111-123456789abc",
                     "action": self.meta["incarnation"] + ":2", "registration": self.meta}
        public = self.root / "public" / self.key
        current = public / "current.json"
        other = {**self.meta, "registrationGeneration": self.next_metadata()["registrationGeneration"]}
        with self.assertRaisesRegex(storage.RegistrationError, "pointer changed"):
            storage.withdraw_managed(self.fd, {**requested, "registration": other}, GID)
        self.assertTrue(current.exists())
        self.assertFalse((public / "withdrawal.json").exists())

        with mock.patch.object(storage.os, "unlink", side_effect=OSError("before unlink")):
            with self.assertRaisesRegex(storage.RegistrationError, "withdrawal uncertain"):
                storage.withdraw_managed(self.fd, requested, GID)
        self.assertTrue(current.exists())
        self.assertFalse((public / "withdrawn.json").exists())
        intent_stat = (public / "withdrawal.json").stat()

        def lose_unlink_ack(path, **kwargs):
            unlink(path, **kwargs)
            raise OSError("after unlink")

        unlink = os.unlink
        with mock.patch.object(storage.os, "unlink", side_effect=lose_unlink_ack):
            with self.assertRaisesRegex(storage.RegistrationError, "withdrawal uncertain"):
                storage.withdraw_managed(self.fd, requested, GID)
        self.assertFalse(current.exists())
        self.assertFalse((public / "withdrawn.json").exists())
        with self.assertRaisesRegex(storage.RegistrationError, "withdrawal fence"):
            self.publish(self.next_metadata())

        self.assertEqual(storage.withdraw_managed(self.fd, requested, GID), requested)
        self.assertEqual((public / "withdrawal.json").stat().st_ino, intent_stat.st_ino)
        self.assertEqual((public / "withdrawal.json").read_bytes(), (public / "withdrawn.json").read_bytes())
        complete = (public / "withdrawn.json").stat()
        self.assertEqual((complete.st_uid, complete.st_gid, stat.S_IMODE(complete.st_mode)), (0, 0, 0o444))
        self.assertEqual(storage.withdraw_managed(self.fd, requested, GID), requested)
        self.assertEqual((public / "withdrawn.json").stat().st_ino, complete.st_ino)
        self.assertTrue((self.path(True) / "configuration.json").is_file())
        self.assertEqual(json.loads((self.path() / "ownership.json").read_text()), owner)
        self.assertEqual(self.observation()["status"], "not-applied")
        with self.assertRaisesRegex(storage.RegistrationError, "conflict"):
            storage.withdraw_managed(self.fd, {**requested, "action": self.meta["incarnation"] + ":3"}, GID)

    def test_host_remove_waits_for_coordinator_and_recovers_after_pointer_withdrawal(self):
        self.swarm_registration()
        storage.publish(self.fd, self.meta, self.fixture["registration"], self.fixture["configuration"], self.fixture["secrets"],
                        GID, ownership=self.ownership())
        app = self.meta["app"]
        request = "12345678-1111-4111-8111-123456789abc"
        withdrawal = {"version": 1, "request": request, "action": self.meta["incarnation"] + ":2", "registration": self.meta}
        current = self.root / "public" / self.key / "current.json"

        with self.assertRaisesRegex(storage.RegistrationError, "operator intervention"):
            command.remove_managed(self.fd, GID, app, lambda *_: {"status": "held", "request": request})
        self.assertTrue(current.exists())
        with self.assertRaisesRegex(storage.RegistrationError, "changed scope"):
            command.remove_managed(self.fd, GID, app, lambda *_: {
                "status": "withdraw-registration", "withdrawal": {
                    **withdrawal, "registration": {**self.meta, "app": "other"},
                },
            })
        self.assertTrue(current.exists())

        calls = []
        lose_ack = True
        def ctl(operation, selected, *args):
            nonlocal lose_ack
            self.assertEqual(selected, app)
            calls.append(operation)
            if operation == "remove-step":
                return {"status": "withdraw-registration", "withdrawal": withdrawal}
            self.assertEqual((operation, args), ("remove-finalize", (request,)))
            self.assertFalse(current.exists())
            if lose_ack:
                lose_ack = False
                raise storage.RegistrationError("lost finale acknowledgement")
            return {"status": "removed", "request": request}

        with self.assertRaisesRegex(storage.RegistrationError, "lost finale acknowledgement"):
            command.remove_managed(self.fd, GID, app, ctl)
        self.assertFalse(current.exists())
        self.assertEqual(command.remove_managed(self.fd, GID, app, ctl), {"status": "removed", "request": request})
        self.assertEqual(calls, ["remove-step", "remove-finalize"] * 2)

    def test_invalid_ownership_is_refused_before_publication(self):
        self.swarm_registration()
        owner = self.ownership()
        invalid = [dict(owner, runtime="compose"), dict(owner, secret="private")]
        for field, value in (("dataOwner", owner["ownership"]["dataOwner"].upper()), ("dataOwner", self.meta["incarnation"]), ("app", "other"), ("dataOwner", "11111111-1111-0111-1111-111111111111")):
            invalid.append({**owner, "ownership": {**owner["ownership"], field: value}})
        invalid.append({**owner, "registration": self.next_metadata()})
        for reference in invalid:
            with self.subTest(reference=reference), self.assertRaises(storage.RegistrationError):
                storage.publish(self.fd, self.meta, self.fixture["registration"], self.fixture["configuration"], self.fixture["secrets"], GID, ownership=reference)
        self.assertFalse((self.root / "public").exists())

    def test_ownership_publication_recovers_lost_pointer_ack_without_replacement(self):
        self.swarm_registration()
        request = {key: self.fixture[key] for key in ("registration", "configuration", "secrets")}
        request["app"] = self.meta["app"]
        generation = command.execute(self.fd, "stage", GID, request)["generation"]
        metadata = {**self.meta, "registrationGeneration": generation}
        owner = self.ownership(metadata)
        replace = os.replace
        def lost_ack(*args, **kwargs):
            replace(*args, **kwargs)
            raise OSError("lost pointer acknowledgement")
        with mock.patch.object(storage.os, "replace", side_effect=lost_ack):
            with self.assertRaises(OSError):
                command.execute(self.fd, "publish", GID, metadata, ownership=owner)
        path = self.path(generation=generation) / "ownership.json"
        inode = path.stat().st_ino
        self.assertEqual(command.execute(self.fd, "publish", GID, metadata, ownership=owner)["status"], "applied")
        self.assertEqual(path.stat().st_ino, inode)
        changed = {**owner, "ownership": {**owner["ownership"], "dataOwner": "44444444-4444-4444-8444-444444444444"}}
        with self.assertRaises(storage.RegistrationError):
            command.execute(self.fd, "publish", GID, metadata, ownership=changed)
        self.assertEqual(path.stat().st_ino, inode)

    def test_swarm_host_flow_reads_admitted_owner_before_publication(self):
        self.swarm_registration()
        request = {key: self.fixture[key] for key in ("registration", "configuration", "secrets")}
        request["app"] = self.meta["app"]
        calls = []
        def control(operation, app, generation, *arguments):
            calls.append(operation)
            ticket = self.meta["actionId"]
            if operation == "reserve":
                return {"incarnation": self.meta["incarnation"], "ticket": ticket}
            self.assertEqual(arguments, (ticket,))
            if operation == "submit":
                return {"status": "reconcile", "actionId": ticket}
            if operation == "ownership":
                return self.ownership({**self.meta, "registrationGeneration": generation})
            self.assertEqual(operation, "reconcile")
            return {"status": "verified"}
        def platform(operation, app, generation, ticket):
            calls.append("platform/app-overlay")
            self.assertEqual((operation, app, ticket), ("app-overlay", self.meta["app"], self.meta["actionId"]))
            return self.infrastructure({**self.meta, "registrationGeneration": generation})["overlay"]
        self.assertEqual(command.register(self.fd, GID, request, control, platform), {"status": "verified"})
        self.assertEqual(calls, ["reserve", "submit", "ownership", "platform/app-overlay", "reconcile"])
        calls.clear()
        self.assertEqual(command.register(self.fd, GID, request, control, platform), {"status": "verified"})
        self.assertEqual(calls, ["reserve", "submit", "ownership", "platform/app-overlay", "reconcile"])

    def test_swarm_payloads_are_explicit_and_publication_refuses_backend_conversion(self):
        registration = self.swarm_registration()
        self.publish()
        self.assertEqual(json.loads((self.path() / "registration.json").read_text())["runtime"], "swarm")
        following = self.next_metadata()
        self.fixture["registration"] = {key: value for key, value in registration.items() if key != "grants"}
        self.fixture["registration"]["runtime"] = "compose"
        with self.assertRaisesRegex(storage.RegistrationError, "runtime changes"):
            self.publish(following, self.meta)
        self.assertFalse(self.path(generation=following["registrationGeneration"]).exists())
        for grants in ({}, {"memory_bytes": True, "cpu_millicores": 500, "maintenance": False}, {"memory_bytes": 268435456, "cpu_millicores": 500}):
            with self.subTest(grants=grants), self.assertRaises(storage.RegistrationError):
                storage._registration({**registration, "grants": grants}, self.meta)

    def test_swarm_registration_requires_current_owned_host_authority_and_bounded_grants(self):
        registration = self.swarm_registration()
        authority = json.loads((ROOT / "ci/tests/swarm-host/authority.json").read_text())
        directory = Path(self.enterContext(tempfile.TemporaryDirectory(prefix="kayra-swarm-authority-", dir="/var/lib"))) / "swarm"
        directory.mkdir(mode=0o755)
        public = directory / "authority.json"
        def publish(value):
            if public.exists():
                public.unlink()
            public.write_text(json.dumps(value))
            public.chmod(0o444)
        def observe(*args):
            if args[0] == "info":
                return {"LocalNodeState": "active", "ControlAvailable": True, "Nodes": 1, "Managers": 1, "NodeAddr": authority["profile"]["advertise_address"], "NodeID": authority["node"], "Cluster": {"ID": authority["cluster"]}}
            return [{"Id": authority["network"]["id"], "Name": "platform-swarm", "Driver": "overlay", "Scope": "swarm", "Attachable": True, "Ingress": False}]
        with self.assertRaises(FileNotFoundError):
            command.admit_runtime(registration, str(directory), observe)
        publish(authority)
        command.admit_runtime(registration, str(directory), observe)
        with self.assertRaisesRegex(storage.RegistrationError, "workload capacity"):
            command.admit_runtime({**registration, "grants": {**registration["grants"], "memory_bytes": authority["profile"]["memory_bytes"]}}, str(directory), observe)
        with self.assertRaisesRegex(storage.RegistrationError, "membership"):
            command.admit_runtime(registration, str(directory), lambda *args: {"LocalNodeState": "inactive"})
        with self.assertRaisesRegex(storage.RegistrationError, "overlay"):
            command.admit_runtime(registration, str(directory), lambda *args: observe(*args) if args[0] == "info" else [])
        publish({**authority, "profile": {**authority["profile"], "advertise_address": "invalid"}})
        with self.assertRaisesRegex(storage.RegistrationError, "advertise"):
            command.admit_runtime(registration, str(directory), observe)

    def test_new_swarm_name_refuses_existing_native_objects_without_blocking_an_owned_retry(self):
        app = "swarm-fixture"
        for name in ("apps", "removing", "removal-locks", "managed-apps"):
            (self.root / name).mkdir(mode=0o755)
        marker = self.root / "managed-apps" / (app + ".json")
        with self.assertRaisesRegex(storage.RegistrationError, "existing Swarm"):
            with command.claim_experimental_app(self.root, app, lambda _: False, lambda _: True):
                self.fail("native namespace collision was claimed")
        self.assertFalse(marker.exists())
        with command.claim_experimental_app(self.root, app, lambda _: False, lambda _: False):
            pass
        with command.claim_experimental_app(self.root, app, lambda _: False, lambda _: True):
            self.assertTrue(marker.exists())


if __name__ == "__main__":
    if sys.platform != "linux" or os.geteuid() != 0:
        raise SystemExit("registration storage tests require Linux root")
    unittest.main(verbosity=2)
