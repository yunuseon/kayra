"""Root-owned Linux publisher recreation tests in isolated temporary storage."""
import base64
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest import mock
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts" / "server-lib"))
import registration_generation as storage
from registration_command import register


def metadata():
    incarnation = str(uuid.uuid4())
    return {"version": 1, "app": "shop", "incarnation": incarnation,
            "actionId": incarnation + ":1", "registrationGeneration": str(uuid.uuid4())}


def ownership(registration, data_owner):
    return {"version": 1, "runtime": "swarm", "registration": registration,
            "ownership": {"version": 1, "app": "shop", "incarnation": registration["incarnation"],
                          "dataOwner": data_owner}}


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "Linux root ownership required")
class RecreatedPublisher(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="kayra-recreation-publisher-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.fd = os.open(self.root, storage._DIR_FLAGS)
        self.addCleanup(os.close, self.fd)
        self.previous = metadata()
        self.target = metadata()
        self.data_owner = str(uuid.uuid4())
        self.registration = {"name": "shop", "repo": "https://example.test/shop.git", "ref": "main",
                             "path": ".", "runtime": "swarm", "hosts": ["shop.example.test"], "secrets": ["TOKEN"],
                             "grants": {"memory_bytes": 1048576, "cpu_millicores": 100, "maintenance": False}}
        self.secrets = {"TOKEN": "fixture-private-value"}
        self.configuration = {"MODE": "lab"}
        storage.publish(self.fd, self.previous, self.registration, self.configuration, self.secrets, 1000,
                        ownership=ownership(self.previous, self.data_owner))
        withdrawal = {"version": 1, "request": str(uuid.uuid4()), "action": self.previous["incarnation"] + ":2",
                      "registration": self.previous}
        self.withdrawal = storage.withdraw_managed(self.fd, withdrawal, 1000)
        self.public = next((self.root / "public").iterdir())
        self.current = self.public / "current.json"
        self.old_marker = self.public / ("withdrawal-" + self.previous["incarnation"] + ".json")

    def publish(self, data_owner=None, withdrawal=None, deadline=None):
        owner = ownership(self.target, data_owner or self.data_owner)
        infra = {**owner, "overlay": {"id": "n" * 25, "scope": {
            "version": 1, "app": "shop", "incarnation": self.target["incarnation"],
            "node": "m" * 25, "cluster": "c" * 25, "name": "kayra-app-" + self.target["incarnation"]}}}
        return storage.publish_recreated(self.fd, self.target, self.registration, self.configuration,
                                         self.secrets, 1000, owner, infra, withdrawal or self.withdrawal,
                                         deadline if deadline is not None else time.time_ns() // 1_000_000 + 90_000)

    def assert_published(self):
        self.assertEqual(json.loads(self.current.read_bytes()), self.target)
        self.assertEqual(json.loads(self.old_marker.read_bytes()), self.withdrawal)
        self.assertFalse((self.public / "withdrawal.json").exists())
        self.assertFalse((self.public / "withdrawn.json").exists())
        self.assertEqual(storage.observe(self.fd, self.target, 1000)["status"], "applied")
        self.assertEqual(self.publish(), self.target)
        self.assertEqual(len(list((self.public / "generations").iterdir())), 2)
        for path in self.public.rglob("*.json"):
            self.assertNotIn(self.secrets["TOKEN"].encode(), path.read_bytes())

    def test_requires_the_exact_withdrawn_owner(self):
        with self.assertRaisesRegex(storage.RegistrationError, "withdrawal disagrees"):
            self.publish(withdrawal={**self.withdrawal, "request": str(uuid.uuid4())})
        with self.assertRaisesRegex(storage.RegistrationError, "data owner changed"):
            self.publish(data_owner=str(uuid.uuid4()))
        self.assertFalse(self.current.exists())
        self.assertFalse(self.old_marker.exists())
        with self.assertRaisesRegex(storage.RegistrationError, "deadline expired"):
            self.publish(deadline=1)
        self.assertFalse(self.current.exists())
        self.assertEqual(self.publish(), self.target)
        self.assert_published()

    def test_refuses_changed_fleet_inputs_before_custody(self):
        changed = {"request": str(uuid.uuid4()), "removal": self.withdrawal["request"],
                   "reason": "Reopen with conflicting fixture inputs"}
        publication = {"app": "shop", "registration": self.registration, "configuration": self.configuration, "secrets": self.secrets}
        unexpected = mock.Mock(side_effect=AssertionError("recreation must validate inputs before calling custody"))
        for key, value, message in (
            ("registration", {**self.registration, "hosts": ["elsewhere.example.test"]}, "previous fleet registration"),
            ("configuration", {"MODE": "different"}, "previous application configuration"),
            ("secrets", {"TOKEN": "different"}, "previous secret values"),
        ):
            with self.subTest(changed=key), self.assertRaisesRegex(storage.RegistrationError, message):
                register(self.fd, 1000, {**publication, key: value}, unexpected,
                         recreation=changed, recreation_ctl=unexpected)
        unexpected.assert_not_called()
        self.assertFalse(self.current.exists())
        self.assertFalse(self.old_marker.exists())

    def test_restarts_after_private_generation_is_installed(self):
        install = storage._install_recreated_generation

        def lost_reply(*args):
            install(*args)
            raise OSError("cut after private generation")

        with mock.patch.object(storage, "_install_recreated_generation", side_effect=lost_reply):
            with self.assertRaisesRegex(storage.RegistrationError, "publication uncertain"):
                self.publish()
        self.assertFalse(self.current.exists())
        self.assertTrue((self.public / "withdrawal.json").exists())
        self.assertEqual(self.publish(), self.target)
        self.assert_published()

    def test_restarts_after_current_pointer_is_durable(self):
        unlink = storage.os.unlink

        def lost_reply(name, *args, **kwargs):
            if name == "withdrawn.json":
                raise OSError("cut before clearing the last old fence")
            return unlink(name, *args, **kwargs)

        with mock.patch.object(storage.os, "unlink", side_effect=lost_reply):
            with self.assertRaisesRegex(storage.RegistrationError, "publication uncertain"):
                self.publish()
        self.assertEqual(json.loads(self.current.read_bytes()), self.target)
        self.assertTrue((self.public / "withdrawn.json").exists())
        self.assertEqual(self.publish(deadline=1), self.target)
        self.assert_published()
        with self.assertRaises(storage.RegistrationError):
            storage.withdraw_managed(self.fd, self.withdrawal, 1000)

    def test_host_retries_with_the_same_staged_generation(self):
        intent = {"request": str(uuid.uuid4()), "removal": self.withdrawal["request"],
                  "reason": "Reopen the previously verified data in a new workload incarnation"}
        publication = {"app": "shop", "registration": self.registration,
                       "configuration": self.configuration, "secrets": self.secrets}
        owner = lambda: ownership(self.target, self.data_owner)
        ticket = self.target["incarnation"] + ":1"
        generations = []
        deadline = time.time_ns() // 1_000_000 + 90_000

        def reserve(operation, encoded):
            self.assertEqual(operation, "recreate-registration")
            decoded = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
            generation = decoded.pop("generation")
            self.assertEqual(decoded, {"app": "shop", **intent})
            generations.append(generation)
            if len(generations) == 1:
                raise storage.RegistrationError("lost reservation reply")
            self.target["registrationGeneration"] = generation
            return {"incarnation": self.target["incarnation"], "ticket": ticket,
                    "withdrawal": self.withdrawal, "deadline": deadline}

        def ctl(operation, app, generation, allocated):
            self.assertEqual((app, generation, allocated), ("shop", self.target["registrationGeneration"], ticket))
            if operation == "submit":
                return {"status": "terminal", "outcome": "success"} if self.current.exists() else {
                    "status": "new", "actionId": self.target["actionId"]}
            if operation == "ownership":
                return owner()
            self.assertEqual(operation, "reconcile")
            self.assertEqual(storage.observe(self.fd, self.target, 1000)["status"], "applied")
            return {"status": "verified"}

        def overlay(operation, app, generation, allocated):
            self.assertEqual((operation, app, generation, allocated),
                             ("app-overlay", "shop", self.target["registrationGeneration"], ticket))
            return {"id": "n" * 25, "scope": {"version": 1, "app": app, "incarnation": self.target["incarnation"],
                                               "node": "m" * 25, "cluster": "c" * 25,
                                               "name": "kayra-app-" + self.target["incarnation"]}}

        def perform():
            return register(self.fd, 1000, publication, ctl, overlay, recreation=intent, recreation_ctl=reserve)

        with self.assertRaisesRegex(storage.RegistrationError, "lost reservation reply"):
            perform()
        self.assertFalse(self.current.exists())
        self.assertEqual(perform(), {"status": "verified"})
        self.assertEqual(perform(), {"status": "terminal", "outcome": "success"})
        self.assertEqual(len(set(generations)), 1)
        self.assertEqual(storage.stage_initial_registration(self.fd, **publication), generations[0])
        self.assert_published()


if __name__ == "__main__":
    unittest.main()
