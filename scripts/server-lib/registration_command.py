"""Root-side command for staged initial registration.

The host supplies a root-controlled storage path. Publish and verify take the
identity returned by the lifecycle owner while its registration fence is held.
"""
import argparse
import contextlib
import json
import os
from pathlib import PurePosixPath
import sys

import registration_generation as storage


@contextlib.contextmanager
def trusted_root(value):
    path = PurePosixPath(value)
    storage._require(path.anchor == "/" and ".." not in path.parts and len(path.parts) > 1,
                     "invalid registration root path")
    with contextlib.ExitStack() as stack:
        fd = os.open("/", storage._DIR_FLAGS)
        stack.callback(os.close, fd)
        storage._check_root(fd)
        for part in path.parts[1:]:
            fd = os.open(part, storage._DIR_FLAGS, dir_fd=fd)
            stack.callback(os.close, fd)
            storage._check_root(fd)
        yield fd


def execute(root, mode, gid, request):
    if mode == "stage":
        fields = {"app", "registration", "configuration", "secrets"}
        storage._require(type(request) is dict and set(request) == fields, "invalid initial registration request")
        return {"generation": storage.stage_initial_registration(root, **request)}
    if mode == "verify":
        return storage.record_publication_evidence(root, request, gid)

    evidence = storage.record_publication_evidence(root, request, gid)
    if evidence["status"] == "applied":
        return evidence
    try:
        storage.publish_staged_initial_registration(root, request, gid)
    except storage.RegistrationError:
        # Publication may have completed despite a failed acknowledgement.
        evidence = storage.record_publication_evidence(root, request, gid)
        if evidence["status"] == "applied":
            return evidence
        raise
    return storage.record_publication_evidence(root, request, gid)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("stage", "publish", "verify"))
    parser.add_argument("--root", required=True)
    parser.add_argument("--private-gid", type=int, required=True)
    args = parser.parse_args()
    try:
        storage._require(0 <= args.private_gid <= 2147483647, "invalid registration group")
        raw = sys.stdin.buffer.read(storage.MAX_STAGED_BYTES + 1)
        storage._require(len(raw) <= storage.MAX_STAGED_BYTES, "registration request too large")
        request = storage._decode(raw)
        with trusted_root(args.root) as root:
            result = execute(root, args.mode, args.private_gid, request)
        print(json.dumps(result))
    except (OSError, RecursionError):
        print("registration host operation failed; reconcile before retrying", file=sys.stderr)
        return 1
    except storage.RegistrationError as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
