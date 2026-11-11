"""Root-side command for staged initial registration.

The host supplies a root-controlled storage path. Publish and verify take the
identity returned by the lifecycle owner while its registration fence is held.
"""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
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
        registration_request(request)
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


def registration_request(request):
    fields = {"app", "registration", "configuration", "secrets"}
    storage._require(type(request) is dict and set(request) == fields, "invalid initial registration request")
    app = request["app"]
    storage._require(type(app) is str and bool(storage._APP.fullmatch(app)), "invalid staged app name")
    return app


def legacy_objects(app):
    label = "label=com.docker.compose.project=" + app
    try:
        return any(subprocess.check_output(["docker", *command, "--filter", label], timeout=10).strip()
                   for command in (("ps", "-aq"), ("volume", "ls", "-q")))
    except (OSError, subprocess.SubprocessError):
        raise storage.RegistrationError("could not check legacy Compose ownership") from None


@contextlib.contextmanager
def claim_experimental_app(platform_dir, app, inspect=legacy_objects):
    """Fence all cooperating legacy writers before an indexed app uses the name."""
    storage._require(type(app) is str and bool(storage._APP.fullmatch(app)), "invalid staged app name")
    platform = Path(platform_dir)
    path = platform / "removal-locks" / (app + ".lock")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o644)
    try:
        info = os.fstat(fd)
        storage._require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1, "invalid host app lock")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise storage.RegistrationError("another operation holds the app lock") from None
        legacy = (platform / "apps" / (app + ".json"), platform / "removing" / (app + ".json"),
                  platform / "runs" / app, platform / "releases" / app, platform / "app-secrets" / app)
        storage._require(not any(os.path.lexists(item) for item in legacy) and not inspect(app),
                         "legacy Compose state already uses the app name")
        directory = os.open(platform / "managed-apps", storage._DIR_FLAGS)
        try:
            storage._check(directory, 0o755, 0, True)
            name = app + ".json"
            try:
                storage._new_file(directory, name, b"", 0o444)
            except FileExistsError:
                storage._read_file(directory, name, 0o444)
            os.fsync(directory)
        finally:
            os.close(directory)
        yield
    finally:
        os.close(fd)


def register(root, gid, request, ctl):
    generation = execute(root, "stage", gid, request)["generation"]
    app = request["app"]
    reservation = ctl("reserve", app, generation)
    storage._require(type(reservation) is dict and set(reservation) == {"incarnation", "ticket"},
                     "invalid registration reservation")
    incarnation, ticket = reservation["incarnation"], reservation["ticket"]
    storage._require(type(incarnation) is str and bool(storage._UUID.fullmatch(incarnation))
                     and type(ticket) is str and ticket.startswith(incarnation + ":"),
                     "invalid registration ticket")

    intent = ctl("submit", app, generation, ticket)
    if intent == {"status": "terminal", "outcome": "success"}:
        return intent
    storage._require(type(intent) is dict and set(intent) == {"status", "actionId"}
                     and intent["status"] in ("new", "reconcile"), "invalid registration intent")
    metadata = storage._metadata({"version": 1, "app": app, "incarnation": incarnation,
                                  "registrationGeneration": generation, "actionId": intent["actionId"]})
    # The platform command uses the immutable staged inputs and exclusive
    # generation creation even if the original submit acknowledgement was lost.
    evidence = execute(root, "publish", gid, metadata)
    storage._require(evidence["status"] == "applied", "registration publication remains unresolved")
    receipt = ctl("reconcile", app, generation, ticket)
    storage._require(receipt in ({"status": "verified"}, {"status": "terminal", "outcome": "success"}),
                     "registration receipt remains unresolved")
    return receipt


def docker_control(platform_dir, *args):
    try:
        result = subprocess.run(
            ["docker", "compose", "exec", "-T", "deployer", "kayra-deployer", "ctl", "registration", *args],
            cwd=platform_dir, check=True, capture_output=True, timeout=20,
        )
    except (OSError, subprocess.SubprocessError):
        raise storage.RegistrationError("registration control unavailable; retry the same request") from None
    storage._require(len(result.stdout) <= storage.MAX_FILE_BYTES, "registration control reply too large")
    return storage._decode(result.stdout)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("stage", "publish", "verify", "register"))
    parser.add_argument("--root", required=True)
    parser.add_argument("--private-gid", type=int, required=True)
    parser.add_argument("--platform-dir")
    args = parser.parse_args()
    try:
        storage._require(0 <= args.private_gid <= 2147483647, "invalid registration group")
        raw = sys.stdin.buffer.read(storage.MAX_STAGED_BYTES + 1)
        storage._require(len(raw) <= storage.MAX_STAGED_BYTES, "registration request too large")
        request = storage._decode(raw)
        with trusted_root(args.root) as root:
            if args.mode == "register":
                storage._require(args.platform_dir is not None and os.path.isabs(args.platform_dir),
                                 "register requires an absolute platform directory")
                app = registration_request(request)
                storage._payload(app, request["registration"], request["configuration"], request["secrets"])
                with claim_experimental_app(args.platform_dir, app):
                    result = register(root, args.private_gid, request,
                                      lambda *values: docker_control(args.platform_dir, *values))
            else:
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
