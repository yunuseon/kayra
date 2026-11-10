"""Linux lab bridge for synthetic fixture data only."""
import json
import os
from pathlib import Path
import sys

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "scripts/server-lib"))
from registration_generation import observe, publish_staged_initial_registration, stage_initial_registration

mode, directory = sys.argv[1:]
expected = json.load(sys.stdin)
root = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    if mode == "stage":
        fixture = json.loads((REPO / "ci/tests/registration-generation/fixture.json").read_text())
        print(stage_initial_registration(root, expected["app"], fixture["registration"],
                                         fixture["configuration"], fixture["secrets"]))
    elif mode == "publish":
        publish_staged_initial_registration(root, {"version": 1, **expected}, 0)
    elif mode == "observe":
        print(json.dumps(observe(root, {"version": 1, **expected}, 0)))
    else:
        raise ValueError("unknown fixture operation")
finally:
    os.close(root)
