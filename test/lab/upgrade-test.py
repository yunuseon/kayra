"""Exercise upgrade-lab resource safety without starting a VM."""

import os
import shutil
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
LAB = ROOT / "test/lab/upgrade.sh"
GIT_HTTP = ROOT / "test/lab/git-http.py"


class UpgradeLabSafety(unittest.TestCase):
    def test_existing_vm_is_refused_before_any_provisioning(self):
        with tempfile.TemporaryDirectory() as temporary:
            multipass = Path(temporary) / "multipass"
            multipass.write_text("#!/bin/sh\n[ \"$1\" = info ] && [ \"$2\" = existing ]\n")
            multipass.chmod(0o755)
            env = {**os.environ, "PATH": f"{temporary}:{os.environ['PATH']}"}
            result = subprocess.run(["bash", str(LAB), "--vm-name", "existing"], env=env, text=True, capture_output=True, check=False)
            self.assertEqual(result.returncode, 1)
            self.assertIn("already exists", result.stderr)

    def test_fixture_servers_bind_distinct_ports(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            processes = [
                subprocess.Popen(["python3", str(GIT_HTTP), "127.0.0.1", "0", temporary, str(directory / f"port{i}")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                for i in range(2)
            ]
            try:
                for _ in range(100):
                    if all((directory / f"port{i}").is_file() and (directory / f"port{i}").stat().st_size for i in range(2)):
                        break
                    time.sleep(0.05)
                ports = [(directory / f"port{i}").read_text() for i in range(2)]
                self.assertNotEqual(ports[0], ports[1])
                self.assertTrue(all(process.poll() is None for process in processes))
            finally:
                for process in processes:
                    process.terminate()
                for process in processes:
                    process.wait(timeout=5)

    def test_success_retains_private_raw_log_after_teardown_before_removing_fleet(self):
        source = LAB.read_text()
        cleanup = source[source.index("retain_lab_log() {"):source.index("\ntrap cleanup EXIT")]
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary) / "work"
            fleet = work / "fleet"
            (fleet / "servers/lab/terraform").mkdir(parents=True)
            log = work / "lab.log"
            log.write_text("platform and component evidence\n")
            script = cleanup + """
work=$1
fleet=$2
log=$3
server=lab
vm_name=fixture-log-retention
passed=true
keep=false
kayra_cmd() { echo 'teardown completed'; }
cleanup
"""
            result = subprocess.run(["bash", "-c", script, "cleanup-test", str(work), str(fleet), str(log)], text=True, capture_output=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(work.exists())
            archived = Path(result.stdout.strip().removeprefix("raw lab log: "))
            try:
                self.assertEqual(archived.read_text(), "platform and component evidence\nteardown completed\n")
                self.assertEqual(archived.stat().st_mode & 0o777, 0o600)
                self.assertEqual(archived.parent.stat().st_mode & 0o777, 0o700)
            finally:
                shutil.rmtree(archived.parent)

    def test_failed_teardown_retains_fleet_and_reports_failure(self):
        source = LAB.read_text()
        cleanup = source[source.index("retain_lab_log() {"):source.index("\ntrap cleanup EXIT")]
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary) / "work"
            fleet = work / "fleet"
            (fleet / "servers/lab/terraform").mkdir(parents=True)
            log = work / "lab.log"
            script = cleanup + """
work=$1
fleet=$2
log=$3
server=lab
vm_name=fixture-vm
passed=true
keep=false
kayra_cmd() { return 1; }
cleanup
"""
            result = subprocess.run(["bash", "-c", script, "cleanup-test", str(work), str(fleet), str(log)], text=True, capture_output=True, check=False)
            self.assertEqual(result.returncode, 1)
            self.assertTrue(fleet.is_dir())
            self.assertTrue(log.exists())
            self.assertIn("kept the VM (fixture-vm)", result.stderr)
            self.assertIn("retry:", result.stderr)


if __name__ == "__main__":
    unittest.main()
