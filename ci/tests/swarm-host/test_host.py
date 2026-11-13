"""Root/Linux tests of platform ownership and interrupted host setup."""
import copy
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("swarm_host", ROOT / "ansible/roles/platform/library/kayra_swarm_host.py")
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
PROFILE = {"enabled": True, "advertise_address": "192.0.2.1", "memory_bytes": 3 * 1024**3, "cpu_millicores": 2000, "platform_memory_bytes": 1024**3, "platform_cpu_millicores": 500}


class Docker:
    def __init__(self):
        self.swarm = {"LocalNodeState": "inactive"}
        self.network = None
        self.effects = []
        self.fail_after = None

    def __call__(self, args):
        if args[0] == "info":
            return json.dumps({"MemTotal": 4 * 1024**3, "NCPU": 2, "Swarm": self.swarm})
        if args[:2] == ["network", "ls"]:
            return "" if self.network is None else json.dumps({"Name": "platform-swarm", "ID": self.network["Id"]})
        if args[:2] == ["network", "inspect"]:
            return json.dumps([self.network])
        if args[:2] == ["swarm", "init"]:
            self.effects.append("init")
            self.swarm = {"LocalNodeState": "active", "ControlAvailable": True, "Managers": 1, "Nodes": 1, "NodeID": "n" * 25, "Cluster": {"ID": "c" * 25}}
        elif args[:2] == ["network", "create"]:
            self.effects.append("network")
            label = args[args.index("--label") + 1]
            key, owner = label.split("=", 1)
            self.network = {"Id": "o" * 25, "Name": "platform-swarm", "Driver": "overlay", "Scope": "swarm", "Attachable": True, "Ingress": False, "Labels": {key: owner}}
        else:
            raise AssertionError(args)
        if self.fail_after == self.effects[-1]:
            raise OSError("lost Docker acknowledgement")
        return ""


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "requires Linux root")
class HostTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="kayra-swarm-unit-", dir="/var/lib")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.directory = self.root / "authority"
        self.docker = Docker()

    def ensure(self, value=PROFILE, check=False):
        return host.ensure(self.directory, value, check, self.docker)

    def test_default_off_and_preview_make_no_files(self):
        self.assertEqual(self.ensure({}), {"changed": False, "enabled": False})
        self.assertFalse(self.directory.exists())
        self.assertEqual(self.ensure(check=True), {"changed": True, "enabled": True})
        self.assertFalse(self.directory.exists())
        self.assertEqual(self.docker.effects, [])

    def test_owned_setup_is_idempotent_and_publishes_only_authority(self):
        first = self.ensure()
        self.assertTrue(first["changed"])
        self.assertFalse(self.ensure()["changed"])
        self.assertFalse(self.ensure(check=True)["changed"])
        self.assertEqual(self.docker.effects, ["init", "network"])
        self.assertEqual(first["authority"]["network"], {"name": "platform-swarm", "id": "o" * 25})
        self.assertEqual(stat.S_IMODE((self.directory / "authority.json").stat().st_mode), 0o444)
        self.assertEqual(stat.S_IMODE((self.directory / "state.json").stat().st_mode), 0o600)
        self.assertEqual(set(first["authority"]), {"version", "profile", "node", "cluster", "network"})

    def test_policy_is_bounded_published_and_independent_of_host_membership(self):
        for value in (0, -1, True, 1.5, "90", 86401):
            with self.subTest(value=value), self.assertRaisesRegex(host.HostError, "migration timeout"):
                host.ensure(self.directory, PROFILE, run=self.docker, migration_timeout_seconds=value)
        self.assertFalse(self.directory.exists())
        self.ensure()
        authority = (self.directory / "authority.json").read_bytes()
        policy = self.directory / "policy" / "migration.json"
        self.assertEqual(json.loads(policy.read_text()), {"version": 1, "migrationTimeoutCeilingSeconds": 90})
        self.assertEqual(stat.S_IMODE(policy.stat().st_mode), 0o444)
        preview = host.ensure(self.directory, PROFILE, True, self.docker, 300)
        self.assertTrue(preview["changed"])
        self.assertEqual(json.loads(policy.read_text())["migrationTimeoutCeilingSeconds"], 90)
        self.assertTrue(host.ensure(self.directory, PROFILE, False, self.docker, 300)["changed"])
        self.assertFalse(host.ensure(self.directory, PROFILE, False, self.docker, 300)["changed"])
        self.assertEqual((self.directory / "authority.json").read_bytes(), authority)
        self.assertEqual(self.docker.effects, ["init", "network"])

    def test_policy_loss_or_lost_publication_acknowledgement_is_recoverable(self):
        self.ensure()
        path = self.directory / "policy" / "migration.json"
        path.unlink()
        self.assertTrue(self.ensure(check=True)["changed"])
        self.assertFalse(path.exists())
        original = host.write
        def write(target, value, mode):
            original(target, value, mode)
            if target == path:
                raise OSError("lost policy publication reply")
        with mock.patch.object(host, "write", side_effect=write), self.assertRaises(OSError):
            self.ensure()
        self.assertFalse(self.ensure()["changed"])
        self.assertEqual(self.docker.effects, ["init", "network"])

    def test_untrusted_published_policy_is_not_silently_repaired(self):
        self.ensure()
        path = self.directory / "policy" / "migration.json"
        path.chmod(0o644)
        with self.assertRaisesRegex(host.HostError, "authority file"):
            self.ensure()
        path.chmod(0o444)
        host.write(path, {"version": 1, "migrationTimeoutCeilingSeconds": 0}, 0o444)
        with self.assertRaisesRegex(host.HostError, "published migration policy"):
            self.ensure()
        path.unlink()
        path.symlink_to(self.directory / "authority.json")
        with self.assertRaises(OSError):
            self.ensure()
        self.assertEqual(self.docker.effects, ["init", "network"])

    def test_unmanaged_membership_or_network_is_not_adopted(self):
        self.docker(["swarm", "init"])
        self.docker.effects.clear()
        with self.assertRaisesRegex(host.HostError, "unmanaged"):
            self.ensure()
        self.assertEqual(self.docker.effects, [])
        self.assertFalse((self.directory / "state.json").exists())
        self.docker.swarm = {"LocalNodeState": "inactive"}
        self.docker.network = {"Id": "b" * 64, "Driver": "bridge", "Scope": "local", "Name": "platform-swarm"}
        with self.assertRaisesRegex(host.HostError, "owned attachable"):
            self.ensure()
        self.assertEqual(self.docker.effects, [])

    def test_lost_docker_replies_reconcile_without_repeating_effects(self):
        for effect in ("init", "network"):
            with self.subTest(effect=effect):
                self.directory = self.root / effect
                self.docker = Docker()
                self.docker.fail_after = effect
                with self.assertRaises(OSError):
                    self.ensure()
                self.docker.fail_after = None
                result = self.ensure()
                self.assertEqual(self.docker.effects, ["init", "network"])
                self.assertEqual(self.ensure()["authority"], result["authority"])

    def test_lost_ready_or_publication_reply_preserves_identity(self):
        original = host.write
        for boundary in ("state.json", "authority.json"):
            with self.subTest(boundary=boundary):
                self.directory = self.root / boundary
                self.docker = Docker()
                def write(path, value, mode):
                    original(path, value, mode)
                    if path.name == boundary and (path.name == "authority.json" or value.get("phase") == "ready"):
                        raise OSError("lost file acknowledgement")
                with mock.patch.object(host, "write", side_effect=write):
                    with self.assertRaises(OSError):
                        self.ensure()
                result = self.ensure()
                self.assertEqual(self.docker.effects, ["init", "network"])
                self.assertEqual(self.ensure()["authority"], result["authority"])

    def test_disappearing_or_changed_runtime_ownership_requires_intervention(self):
        self.ensure()
        original = copy.deepcopy(self.docker.network)
        self.docker.network = None
        with self.assertRaisesRegex(host.HostError, "network disappeared"):
            self.ensure()
        self.docker.network = {**original, "Id": "x" * 25}
        with self.assertRaisesRegex(host.HostError, "network identity changed"):
            self.ensure()
        self.docker.network = original
        self.docker.swarm["NodeID"] = "x" * 25
        with self.assertRaisesRegex(host.HostError, "ownership changed"):
            self.ensure()
        self.docker.swarm = {"LocalNodeState": "inactive"}
        with self.assertRaisesRegex(host.HostError, "membership disappeared"):
            self.ensure()
        self.assertEqual(self.docker.effects, ["init", "network"])

    def test_profile_changes_disable_or_multi_node_membership_are_refused(self):
        self.ensure()
        with self.assertRaisesRegex(host.HostError, "retirement"):
            self.ensure({})
        with self.assertRaisesRegex(host.HostError, "profile changes"):
            self.ensure({**PROFILE, "memory_bytes": 2 * 1024**3})
        self.docker.swarm["Nodes"] = 2
        with self.assertRaisesRegex(host.HostError, "no other nodes"):
            self.ensure()
        self.assertEqual(self.docker.effects, ["init", "network"])

    def test_invalid_or_excessive_budgets_are_refused_before_runtime_effects(self):
        for value in ({**PROFILE, "cpu_millicores": True}, {**PROFILE, "enabled": False}, {**PROFILE, "advertise_address": "not an address"}, {**PROFILE, "extra": 1}, {**PROFILE, "platform_memory_bytes": PROFILE["memory_bytes"]}, {**PROFILE, "cpu_millicores": 3000}, {**PROFILE, "memory_bytes": 5 * 1024**3}):
            with self.subTest(profile=value), self.assertRaises(host.HostError):
                self.ensure(value)
        self.assertEqual(self.docker.effects, [])

    def test_missing_state_never_resets_a_live_swarm(self):
        self.ensure()
        (self.directory / "state.json").unlink()
        with self.assertRaisesRegex(host.HostError, "without setup state"):
            self.ensure()
        (self.directory / "authority.json").unlink()
        with self.assertRaisesRegex(host.HostError, "unmanaged"):
            self.ensure()
        self.assertEqual(self.docker.effects, ["init", "network"])

    def test_lock_and_private_files_are_not_replaceable_inputs(self):
        self.ensure()
        fd = os.open(self.directory / "writer.lock", os.O_RDWR)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with self.assertRaisesRegex(host.HostError, "another platform"):
            self.ensure()
        fcntl.flock(fd, fcntl.LOCK_UN)
        state = self.directory / "state.json"
        saved = self.directory / "saved.json"
        state.rename(saved)
        state.symlink_to(saved)
        with self.assertRaises(OSError):
            self.ensure()
        state.unlink()
        saved.rename(state)
        self.directory.chmod(0o777)
        with self.assertRaisesRegex(host.HostError, "untrusted"):
            self.ensure()

    def test_broken_public_symlinks_are_refused_in_apply_and_preview(self):
        self.ensure()
        public = self.directory / "authority.json"
        public.unlink()
        target = self.root / "missing.json"
        public.symlink_to(target)
        for check in (False, True):
            with self.subTest(check=check), self.assertRaises(OSError):
                self.ensure(check=check)
        self.assertTrue(public.is_symlink())
        self.assertFalse(target.exists())

    def test_restrictive_process_umask_does_not_hide_the_public_authority(self):
        previous = os.umask(0o077)
        try:
            self.ensure()
        finally:
            os.umask(previous)
        self.assertEqual(stat.S_IMODE((self.directory / "authority.json").stat().st_mode), 0o444)
        self.assertFalse(self.ensure()["changed"])


if __name__ == "__main__":
    unittest.main()
