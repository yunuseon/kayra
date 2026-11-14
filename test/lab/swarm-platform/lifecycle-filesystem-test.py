"""Root-capable lab fault helper refuses unowned paths before effects."""
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('lifecycle-filesystem.py')


class LifecycleFilesystemSafety(unittest.TestCase):
    def test_unowned_storage_paths_cannot_be_staged_filled_or_released(self):
        with tempfile.TemporaryDirectory() as temporary:
            before = list(Path(temporary).iterdir())
            for mode in ['stage', 'fill', 'release']:
                for path in [temporary, '.', '/var/lib/kayra/swarm/lifecycle-storage-fixture/../other']:
                    result = subprocess.run(['python3', str(SCRIPT), mode, path], text=True, capture_output=True, check=False)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(result.stdout, '')
            self.assertEqual(list(Path(temporary).iterdir()), before)


if __name__ == '__main__':
    unittest.main()
