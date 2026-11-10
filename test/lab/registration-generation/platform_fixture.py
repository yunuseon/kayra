"""Linux lab bridge for synthetic fixture data only."""
import json
import os
from pathlib import Path
import sys

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "scripts/server-lib"))
from registration_generation import observe, publish

mode, directory = sys.argv[1:]
expected = json.load(sys.stdin)
root = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    if mode == "publish":
        fixture = json.loads((REPO / "ci/tests/registration-generation/fixture.json").read_text())
        publish(root, {"version": 1, **expected}, fixture["registration"],
                fixture["configuration"], fixture["secrets"], 0)
    elif mode == "observe":
        print(json.dumps(observe(root, {"version": 1, **expected}, 0)))
    else:
        raise ValueError("unknown fixture operation")
finally:
    os.close(root)
