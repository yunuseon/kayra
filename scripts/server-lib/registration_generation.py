"""Experimental platform-owned registration storage; no live caller installs it.

Linux root callers supply a trusted directory fd whose ancestors cannot be
replaced by untrusted writers. Callers must also hold the coordinator's durable
app fence. The local flock orders this adapter's calls only; it cannot fence
legacy scripts, Docker operations, or a privileged operator bypassing Kayra.
"""
import contextlib
import fcntl
import hashlib
import json
import os
import re
import stat
import sys
import time
import uuid
from urllib.parse import urlsplit

MAX_BYTES = 1024 * 1024
MAX_FILE_BYTES = 64 * 1024
MAX_STAGED_BYTES = 8 * MAX_BYTES
_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
_FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
_APP = re.compile(r"[a-z][a-z0-9-]*\Z")
_KEY = re.compile(r"[A-Z][A-Z0-9_]*\Z")


class RegistrationError(Exception):
    """Fixed messages only: payloads and secret values never enter diagnostics."""


def _require(condition, message="invalid registration generation"):
    if not condition:
        raise RegistrationError(message)


def _metadata(value):
    keys = {"version", "app", "incarnation", "actionId", "registrationGeneration"}
    _require(type(value) is dict and set(value) == keys)
    _require(type(value["version"]) is int and value["version"] == 1)
    _require(all(type(value[key]) is str for key in keys - {"version"}))
    _require(bool(_APP.fullmatch(value["app"])))
    _require(bool(_UUID.fullmatch(value["incarnation"])) and bool(_UUID.fullmatch(value["registrationGeneration"])))
    prefix, separator, number = value["actionId"].rpartition(":")
    _require(separator == ":" and prefix == value["incarnation"] and bool(re.fullmatch(r"[1-9][0-9]{0,15}", number)))
    _require(int(number) < 9007199254740991)
    return dict(value)


def _ownership(value, expected):
    """Validated owner reference from the admitted coordinator control read."""
    _require(type(value) is dict and set(value) == {"version", "runtime", "registration", "ownership"}, "invalid registration ownership")
    _require(type(value["version"]) is int and value["version"] == 1 and value["runtime"] == "swarm", "invalid registration ownership")
    _require(_metadata(value["registration"]) == expected, "registration ownership scope disagrees")
    owner = value["ownership"]
    _require(type(owner) is dict and set(owner) == {"version", "app", "incarnation", "dataOwner"}, "invalid registration ownership")
    canonical_uuid = r"(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)"
    _require(type(owner["version"]) is int and owner["version"] == 1 and owner["app"] == expected["app"] and owner["incarnation"] == expected["incarnation"], "registration ownership scope disagrees")
    _require(all(type(owner[key]) is str and bool(re.fullmatch(canonical_uuid, owner[key])) for key in ("incarnation", "dataOwner")) and owner["incarnation"] != owner["dataOwner"], "invalid registration ownership")
    return {"version": 1, "runtime": "swarm", "registration": dict(expected), "ownership": dict(owner)}


def _infrastructure(value, expected, ownership):
    _require(type(value) is dict and set(value) == {"version", "runtime", "registration", "ownership", "overlay"}, "invalid registration infrastructure")
    owner = _ownership({key: value[key] for key in ("version", "runtime", "registration", "ownership")}, expected)
    _require(ownership is not None and owner == ownership, "registration infrastructure owner disagrees")
    overlay = value["overlay"]
    _require(type(overlay) is dict and set(overlay) == {"scope", "id"}, "invalid registration overlay grant")
    scope = overlay["scope"]
    _require(type(scope) is dict and set(scope) == {"version", "app", "incarnation", "node", "cluster", "name"}, "invalid registration overlay scope")
    _require(type(scope["version"]) is int and scope["version"] == 1 and scope["app"] == expected["app"] and scope["incarnation"] == expected["incarnation"] and scope["name"] == "kayra-app-" + expected["incarnation"], "registration overlay scope disagrees")
    _require(len(expected["app"]) <= 48 and bool(re.fullmatch(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", expected["app"])), "invalid registration overlay scope")
    _require(all(type(item) is str and bool(re.fullmatch(r"[a-z0-9]{25}", item)) for item in (overlay["id"], scope["node"], scope["cluster"])), "invalid registration overlay identity")
    return {**owner, "overlay": {"scope": dict(scope), "id": overlay["id"]}}


def _encoded(value, limit=MAX_FILE_BYTES):
    try:
        data = json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("ascii")
    except (TypeError, ValueError, OverflowError):
        raise RegistrationError("invalid registration payload") from None
    _require(len(data) <= limit, "registration payload too large")
    return data


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        _require(key not in result, "duplicate registration field")
        result[key] = value
    return result


def _decode(data):
    try:
        return json.loads(data, object_pairs_hook=_pairs)
    except (UnicodeError, ValueError):
        raise RegistrationError("invalid registration JSON") from None


def _registration(value, metadata):
    _require(type(value) is dict and value.get("runtime") in ("compose", "swarm"))
    fields = {"name", "repo", "ref", "path", "runtime", "hosts", "secrets"}
    _require(set(value) == fields | ({"grants"} if value["runtime"] == "swarm" else set()))
    _require(value["name"] == metadata["app"])
    if value["runtime"] == "swarm":
        _require(len(value["name"]) <= 48 and bool(re.fullmatch(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", value["name"])), "invalid Swarm application name")
        grants = value["grants"]
        _require(type(grants) is dict and set(grants) == {"memory_bytes", "cpu_millicores", "maintenance"}, "explicit Swarm grants required")
        _require(all(type(grants[key]) is int and 0 < grants[key] <= 2**53 - 1 for key in ("memory_bytes", "cpu_millicores")) and type(grants["maintenance"]) is bool, "invalid Swarm grants")
    _require(all(type(value[key]) is str and "\0" not in value[key] for key in ("repo", "ref", "path")))
    try:
        _require(all(len(value[key].encode("utf8")) <= 8192 for key in ("repo", "ref", "path")))
        repo = urlsplit(value["repo"])
        _require(repo.scheme in ("http", "https", "ssh") and repo.hostname is not None and repo.password is None)
        _require(repo.scheme == "ssh" or repo.username is None)
        _require(repo.port is None or 1 <= repo.port <= 65535)
    except (UnicodeError, ValueError):
        raise RegistrationError("invalid registration repository") from None
    _require(bool(re.fullmatch(r"[A-Za-z0-9_./-]+", value["ref"])))
    _require(".." not in value["path"].split("/"))
    for key, pattern in (("hosts", r"[a-z0-9.-]+"), ("secrets", r"[A-Z][A-Z0-9_]*")):
        items = value[key]
        _require(type(items) is list and len(items) <= 128)
        _require(all(type(item) is str and len(item) <= (253 if key == "hosts" else 128) and re.fullmatch(pattern, item) for item in items))
        _require(len(set(items)) == len(items))
    return _decode(_encoded(value))


def _values(value):
    _require(type(value) is dict and len(value) <= 128)
    _require(all(type(key) is str and len(key) <= 128 and _KEY.fullmatch(key) and type(item) is str and "\0" not in item for key, item in value.items()))
    try:
        _require(all(len(item.encode("utf8")) <= MAX_FILE_BYTES for item in value.values()), "registration payload too large")
    except UnicodeError:
        raise RegistrationError("invalid registration value encoding") from None
    return dict(value)


def _check(fd, mode, gid, directory):
    info = os.fstat(fd)
    _require((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)), "unexpected registration file type")
    _require(info.st_uid == 0 and info.st_gid == gid and stat.S_IMODE(info.st_mode) == mode, "unexpected registration permissions")
    _require(directory or info.st_nlink == 1, "unexpected registration hard link")
    return info


@contextlib.contextmanager
def _dir(parent, name, mode, gid=0, create=False):
    made = False
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
            made = True
        except FileExistsError:
            pass
    fd = os.open(name, _DIR_FLAGS, dir_fd=parent)
    try:
        if made:
            os.fchown(fd, 0, gid)
            os.fchmod(fd, mode)
        _check(fd, mode, gid, True)
        # Also seals an entry left visible by an earlier interrupted creation.
        os.fsync(fd)
        os.fsync(parent)
        yield fd
    finally:
        os.close(fd)


def _new_file(parent, name, data, mode, gid=0):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
    try:
        os.fchown(fd, 0, gid)
        os.fchmod(fd, mode)
        remaining = memoryview(data)
        while remaining:
            count = os.write(fd, remaining)
            _require(count > 0, "incomplete registration write")
            remaining = remaining[count:]
        os.fsync(fd)
    finally:
        os.close(fd)


def _read_file(parent, name, mode, gid=0, contents=True, limit=MAX_FILE_BYTES):
    fd = os.open(name, _FILE_FLAGS, dir_fd=parent)
    try:
        info = _check(fd, mode, gid, False)
        _require(info.st_size <= limit, "registration file too large")
        if contents:
            data = bytearray()
            while True:
                chunk = os.read(fd, min(8192, limit + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
                _require(len(data) <= limit, "registration file too large")
            result = bytes(data)
        else:
            result = None
        os.fsync(fd)
        return result
    finally:
        os.close(fd)


def _check_root(root):
    info = os.fstat(root)
    _require(sys.platform == "linux" and os.geteuid() == 0 and stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not (info.st_mode & 0o022), "untrusted registration root")


def _payload(app, registration, configuration, secrets):
    registration = _registration(registration, {"app": app})
    configuration, secrets = _values(configuration), _values(secrets)
    _require(set(secrets) == set(registration["secrets"]) and not set(configuration).intersection(secrets), "registration keys do not match")
    size = len(_encoded(registration)) + len(_encoded(configuration))
    _require(size + sum(len(value.encode("utf8")) for value in secrets.values()) <= MAX_BYTES, "registration payload too large")
    return {"registration": registration, "configuration": configuration, "secrets": secrets}


@contextlib.contextmanager
def _staging(root, app, create=False, recreation=None):
    _check_root(root)
    _require(recreation is None or type(recreation) is str and bool(_UUID.fullmatch(recreation)), "invalid recreation request")
    scope = app if recreation is None else app + ":" + recreation
    key = hashlib.sha256(scope.encode("utf8")).hexdigest()
    category = "initial-requests" if recreation is None else "recreation-requests"
    with _dir(root, category, 0o700, create=create) as requests:
        with _dir(requests, key, 0o700, create=create) as staged:
            yield staged


def _read_staged(staged, app):
    request = _decode(_read_file(staged, "request.json", 0o400, limit=MAX_STAGED_BYTES))
    _require(type(request) is dict and set(request) == {"generation", "registration", "configuration", "secrets"})
    generation = request["generation"]
    _require(type(generation) is str and bool(_UUID.fullmatch(generation)), "invalid staged registration generation")
    payload = _payload(app, request["registration"], request["configuration"], request["secrets"])
    return generation, payload


def stage_initial_registration(root, app, registration, configuration, secrets, recreation=None):
    """Durably bind one root-only request to a generation before allocation."""
    _require(type(app) is str and bool(_APP.fullmatch(app)), "invalid staged app name")
    payload = _payload(app, registration, configuration, secrets)
    try:
        with _staging(root, app, create=True, recreation=recreation) as staged:
            lock = os.open(".lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, 0o600, dir_fd=staged)
            try:
                _check(lock, 0o600, 0, False)
                fcntl.flock(lock, fcntl.LOCK_EX)
                try:
                    generation, previous = _read_staged(staged, app)
                except FileNotFoundError:
                    generation = str(uuid.uuid4())
                    temporary = ".request-" + uuid.uuid4().hex + ".tmp"
                    _new_file(staged, temporary, _encoded({"generation": generation, **payload}, MAX_STAGED_BYTES), 0o400)
                    os.replace(temporary, "request.json", src_dir_fd=staged, dst_dir_fd=staged)
                else:
                    _require(previous == payload, "initial registration payload conflict")
                os.fsync(staged)
                return generation
            finally:
                os.close(lock)
    except OSError:
        raise RegistrationError("initial registration staging uncertain; retry with the same payload") from None


def publish_staged_initial_registration(root, metadata, private_gid, ownership=None, infrastructure=None):
    """Publish staged inputs under an already-held durable registration fence."""
    expected = _metadata(metadata)
    with _staging(root, expected["app"]) as staged:
        generation, payload = _read_staged(staged, expected["app"])
        _require(generation == expected["registrationGeneration"], "staged registration generation conflict")
        os.fsync(staged)
    return publish(root, expected, **payload, private_gid=private_gid, ownership=ownership, infrastructure=infrastructure)


def publish_staged_recreated_registration(root, metadata, request, private_gid, ownership, infrastructure, withdrawal, deadline):
    expected = _metadata(metadata)
    with _staging(root, expected["app"], recreation=request) as staged:
        generation, payload = _read_staged(staged, expected["app"])
        _require(generation == expected["registrationGeneration"], "recreated staged registration generation conflicts")
        os.fsync(staged)
    result = publish_recreated(root, expected, **payload, private_gid=private_gid, ownership=ownership,
                               infrastructure=infrastructure, withdrawal=withdrawal, deadline=deadline)
    # The host's app lock spans publication and promotion. Keep later ordinary
    # registration replays bound to this generation and its immutable payload.
    with _staging(root, expected["app"], create=True) as directory:
        lock = os.open(".lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, 0o600, dir_fd=directory)
        try:
            _check(lock, 0o600, 0, False)
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                current_generation, current_payload = _read_staged(directory, expected["app"])
            except FileNotFoundError:
                current_generation, current_payload = None, None
            if current_generation == generation:
                _require(current_payload == payload, "recreation staging conflicts with the published inputs")
            else:
                previous = _withdrawal_identity(withdrawal)["registration"]
                _require(current_generation in (None, previous["registrationGeneration"]), "recreation staging predecessor disagrees")
                temporary = ".request-" + uuid.uuid4().hex + ".tmp"
                _new_file(directory, temporary, _encoded({"generation": generation, **payload}, MAX_STAGED_BYTES), 0o400)
                os.replace(temporary, "request.json", src_dir_fd=directory, dst_dir_fd=directory)
            os.fsync(directory)
        finally:
            os.close(lock)
    return result


def verify_recreation_inputs(root, app, removal, configuration, secrets, private_gid):
    """Check the retained operator inputs before accepting new custody."""
    configuration = _values(configuration)
    secrets = _values(secrets)
    with _app(root, {"app": app}, private_gid) as (public, _, private_generations):
        if _pointer(public, app) is not None:
            # Replays bind the current publication to the exact staged request.
            return
        recorded = _withdrawal(public)
        completed = _withdrawal(public, "withdrawn.json")
        _require(recorded is not None and recorded == completed and recorded["request"] == removal
                 and recorded["registration"]["app"] == app, "recreation requires a completed withdrawal")
        old = recorded["registration"]
        with _dir(private_generations, old["registrationGeneration"], 0o550, private_gid) as directory:
            _require(_metadata(_decode(_read_file(directory, "manifest.json", 0o440, private_gid))) == old,
                     "recreation predecessor changed")
            config = _values(_decode(_read_file(directory, "configuration.json", 0o440, private_gid)))
            _require(config == configuration, "recreation requires the previous application configuration")
            with _dir(directory, "secrets", 0o550, private_gid) as values:
                _require(set(os.listdir(values)) == set(secrets), "recreation requires the previous secret keys")
                for name, value in secrets.items():
                    _require(_read_file(values, name, 0o440, private_gid) == value.encode("utf8"),
                             "recreation requires the previous secret values")


@contextlib.contextmanager
def _app(root, metadata, private_gid, create=False):
    _check_root(root)
    _require(type(private_gid) is int and 0 <= private_gid <= 2147483647, "invalid registration group")
    key = hashlib.sha256(metadata["app"].encode("utf8")).hexdigest()
    with _dir(root, "public", 0o755, create=create) as public, _dir(root, "private", 0o750, private_gid, create) as private:
        with _dir(public, key, 0o755, create=create) as app_public, _dir(private, key, 0o750, private_gid, create) as app_private:
            lock = os.open(".publisher-lock", os.O_RDWR | (os.O_CREAT if create else 0) | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, 0o600, dir_fd=app_public)
            try:
                _check(lock, 0o600, 0, False)
                fcntl.flock(lock, fcntl.LOCK_EX)
                os.fsync(lock)
                os.fsync(app_public)
                with _dir(app_public, "generations", 0o755, create=create) as public_generations, _dir(app_private, "generations", 0o750, private_gid, create) as private_generations:
                    yield app_public, public_generations, private_generations
            finally:
                os.close(lock)


def _pointer(parent, app):
    try:
        current = _metadata(_decode(_read_file(parent, "current.json", 0o444)))
        _require(current["app"] == app, "registration pointer identity mismatch")
        return current
    except FileNotFoundError:
        return None


def _withdrawal_identity(value):
    _require(type(value) is dict and set(value) == {"version", "request", "action", "registration"}
             and type(value["version"]) is int and value["version"] == 1, "invalid registration withdrawal")
    registration = _metadata(value["registration"])
    request, action = value["request"], value["action"]
    _require(type(request) is str and bool(_UUID.fullmatch(request)), "invalid registration withdrawal request")
    action_meta = _metadata({**registration, "actionId": action})
    _require(int(action_meta["actionId"].split(":")[1]) > int(registration["actionId"].split(":")[1]),
             "registration withdrawal action did not advance")
    return {"version": 1, "request": request, "action": action, "registration": registration}


def _withdrawal(parent, name="withdrawal.json"):
    try:
        raw = _decode(_read_file(parent, name, 0o444))
    except FileNotFoundError:
        return None
    return _withdrawal_identity(raw)


def _write_withdrawal(parent, name, intent):
    temporary = ".withdrawal-" + uuid.uuid4().hex + ".tmp"
    _new_file(parent, temporary, _encoded(intent), 0o444)
    os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
    os.fsync(parent)


def withdraw_managed(root, requested, private_gid):
    """Withdraw a managed pointer after the caller authenticates the coordinator's finalized accounting."""
    intent = _withdrawal_identity(requested)
    expected = intent["registration"]
    try:
        with _app(root, expected, private_gid) as (public, public_generations, _):
            recorded = _withdrawal(public)
            completed = _withdrawal(public, "withdrawn.json")
            current = _pointer(public, expected["app"])
            _require(completed is None or completed == recorded == intent and current is None,
                     "registration withdrawal completion conflicts")
            if recorded is None:
                _require(current == expected, "registration pointer changed")
            else:
                _require(recorded == intent and current in (None, expected), "registration withdrawal conflicts")
            with _dir(public_generations, expected["registrationGeneration"], 0o555) as generation:
                _require(_metadata(_decode(_read_file(generation, "manifest.json", 0o444))) == expected,
                         "registration manifest changed")
                payload = _registration(_decode(_read_file(generation, "registration.json", 0o444)), expected)
                _require(payload["runtime"] == "swarm", "withdrawal requires a managed Swarm registration")
                _ownership(_decode(_read_file(generation, "ownership.json", 0o444)), expected)
            if recorded is None:
                _write_withdrawal(public, "withdrawal.json", intent)
            # Synchronize even on replay. A previous replacement may have lost its acknowledgement.
            os.fsync(public)
            if current is not None:
                os.unlink("current.json", dir_fd=public)
            # Evidence cannot become visible to the deployer before pointer absence is durable.
            os.fsync(public)
            if completed is None:
                _write_withdrawal(public, "withdrawn.json", intent)
    except (OSError, UnicodeError):
        raise RegistrationError("registration withdrawal uncertain; reconcile the same action") from None
    return intent


def publish(root, metadata, registration, configuration, secrets, private_gid, previous=None, ownership=None, infrastructure=None):
    """Publish once under an already-held durable app fence. Never retries effects.

    Existing generations, including partial ones, require reconciliation. A failed
    call may have published; no generation is deleted on failure. `previous` is
    the expected pointer, not permission to roll a registration back.
    """
    expected = _metadata(metadata)
    previous = None if previous is None else _metadata(previous)
    if previous is not None:
        _require(previous["app"] == expected["app"] and previous["incarnation"] == expected["incarnation"], "registration identity changed")
        _require(int(expected["actionId"].rpartition(":")[2]) > int(previous["actionId"].rpartition(":")[2]), "registration action did not advance")
    payload = _payload(expected["app"], registration, configuration, secrets)
    if ownership is not None:
        _require(payload["registration"]["runtime"] == "swarm", "ownership requires Swarm registration")
        ownership = _ownership(ownership, expected)
    if infrastructure is not None:
        infrastructure = _infrastructure(infrastructure, expected, ownership)
    secrets = payload["secrets"]
    metadata_bytes = _encoded(expected)
    registration_bytes = _encoded(payload["registration"])
    config_bytes = _encoded(payload["configuration"])
    generation = expected["registrationGeneration"]
    try:
        with _app(root, expected, private_gid, create=True) as (public, public_generations, private_generations):
            _require(_withdrawal(public) is None and _withdrawal(public, "withdrawn.json") is None,
                     "registration has a withdrawal fence")
            _require(_pointer(public, expected["app"]) == previous, "registration pointer changed")
            if previous is not None:
                with _dir(public_generations, previous["registrationGeneration"], 0o555) as prior:
                    _require(_metadata(_decode(_read_file(prior, "manifest.json", 0o444))) == previous, "previous registration manifest changed")
                    old = _registration(_decode(_read_file(prior, "registration.json", 0o444)), previous)
                    _require(old["runtime"] == registration["runtime"], "registration runtime changes are not supported")
            # Exclusive directory creation avoids overwriting any prior or partial generation.
            os.mkdir(generation, 0o700, dir_fd=private_generations)
            os.mkdir(generation, 0o700, dir_fd=public_generations)
            with _dir(private_generations, generation, 0o700) as private, _dir(public_generations, generation, 0o700) as public_generation:
                _new_file(private, "manifest.json", metadata_bytes, 0o440, private_gid)
                _new_file(private, "configuration.json", config_bytes, 0o440, private_gid)
                os.mkdir("secrets", 0o700, dir_fd=private)
                with _dir(private, "secrets", 0o700) as secret_dir:
                    for key, value in secrets.items():
                        _new_file(secret_dir, key, value.encode("utf8"), 0o440, private_gid)
                    os.fchown(secret_dir, 0, private_gid)
                    os.fchmod(secret_dir, 0o550)
                    os.fsync(secret_dir)
                _new_file(public_generation, "manifest.json", metadata_bytes, 0o444)
                _new_file(public_generation, "registration.json", registration_bytes, 0o444)
                if ownership is not None:
                    _new_file(public_generation, "ownership.json", _encoded(ownership), 0o444)
                if infrastructure is not None:
                    _new_file(public_generation, "infrastructure.json", _encoded(infrastructure), 0o444)
                os.fchown(private, 0, private_gid)
                os.fchmod(private, 0o550)
                os.fchmod(public_generation, 0o555)
                os.fsync(private)
                os.fsync(public_generation)
            os.fsync(private_generations)
            os.fsync(public_generations)
            temporary = ".current-" + uuid.uuid4().hex + ".tmp"
            _new_file(public, temporary, metadata_bytes, 0o444)
            # Preserve everything after an uncertain replacement or sync.
            os.replace(temporary, "current.json", src_dir_fd=public, dst_dir_fd=public)
            os.fsync(public)
    except (OSError, UnicodeError):
        raise RegistrationError("registration publication uncertain; reconcile") from None
    return dict(expected)


def _install_recreated_generation(parent, generation, mode, gid, write, verify):
    try:
        os.stat(generation, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        temporary = ".recreation-" + uuid.uuid4().hex
        with _dir(parent, temporary, 0o700, create=True) as staged:
            write(staged)
            os.fchown(staged, 0, gid)
            os.fchmod(staged, mode)
            os.fsync(staged)
        # The caller holds the app publisher lock, so the final name cannot race
        # another allocation. An interrupted staging directory is never visible.
        os.rename(temporary, generation, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
    with _dir(parent, generation, mode, gid) as existing:
        verify(existing)


def publish_recreated(root, metadata, registration, configuration, secrets, private_gid, ownership, infrastructure, withdrawal, deadline):
    """Publish only the successor independently reserved by the lifecycle owner."""
    expected = _metadata(metadata)
    previous = _withdrawal_identity(withdrawal)
    old = previous["registration"]
    current_owner = _ownership(ownership, expected)
    current_infra = _infrastructure(infrastructure, expected, current_owner)
    payload = _payload(expected["app"], registration, configuration, secrets)
    _require(old["app"] == expected["app"] and old["incarnation"] != expected["incarnation"]
             and old["registrationGeneration"] != expected["registrationGeneration"]
             and expected["actionId"] == expected["incarnation"] + ":1"
             and payload["registration"]["runtime"] == "swarm", "recreation registration scope disagrees")
    _require(type(deadline) is int and 0 < deadline < 2**53, "invalid recreation registration deadline")

    private_files = {"manifest.json": _encoded(expected), "configuration.json": _encoded(payload["configuration"])}
    public_files = {"manifest.json": private_files["manifest.json"], "registration.json": _encoded(payload["registration"]),
                    "ownership.json": _encoded(current_owner), "infrastructure.json": _encoded(current_infra)}
    secret_files = {key: value.encode("utf8") for key, value in payload["secrets"].items()}

    def write_private(parent):
        for name, value in private_files.items():
            _new_file(parent, name, value, 0o440, private_gid)
        with _dir(parent, "secrets", 0o550, private_gid, create=True) as directory:
            for name, value in secret_files.items():
                _new_file(directory, name, value, 0o440, private_gid)
            os.fsync(directory)

    def verify_private(parent):
        _require(set(os.listdir(parent)) == set(private_files) | {"secrets"}, "recreation generation disagrees")
        for name, value in private_files.items():
            _require(_read_file(parent, name, 0o440, private_gid) == value, "recreation generation disagrees")
        with _dir(parent, "secrets", 0o550, private_gid) as directory:
            _require(set(os.listdir(directory)) == set(secret_files), "recreation generation disagrees")
            for name, value in secret_files.items():
                _require(_read_file(directory, name, 0o440, private_gid) == value, "recreation generation disagrees")

    def write_public(parent):
        for name, value in public_files.items():
            _new_file(parent, name, value, 0o444)

    def verify_public(parent):
        _require(set(os.listdir(parent)) == set(public_files), "recreation generation disagrees")
        for name, value in public_files.items():
            _require(_read_file(parent, name, 0o444) == value, "recreation generation disagrees")

    archive = "withdrawal-" + old["incarnation"] + ".json"
    try:
        with _app(root, expected, private_gid) as (public, public_generations, private_generations):
            current = _pointer(public, expected["app"])
            recorded = _withdrawal(public)
            completed = _withdrawal(public, "withdrawn.json")
            archived = _withdrawal(public, archive)
            if current is None:
                _require(recorded == completed == previous and archived in (None, previous), "recreation withdrawal disagrees")
                _require(time.time_ns() // 1_000_000 < deadline, "recreation registration deadline expired")
            else:
                _require(current == expected and archived == previous and recorded in (None, previous)
                         and completed in (None, previous), "recreation publication conflicts")
            with _dir(public_generations, old["registrationGeneration"], 0o555) as directory:
                _require(_metadata(_decode(_read_file(directory, "manifest.json", 0o444))) == old, "recreation predecessor changed")
                predecessor = _ownership(_decode(_read_file(directory, "ownership.json", 0o444)), old)
                _require(predecessor["ownership"]["dataOwner"] == current_owner["ownership"]["dataOwner"], "recreation data owner changed")
            if archived is None:
                _write_withdrawal(public, archive, previous)
            generation = expected["registrationGeneration"]
            _install_recreated_generation(private_generations, generation, 0o550, private_gid, write_private, verify_private)
            _install_recreated_generation(public_generations, generation, 0o555, 0, write_public, verify_public)
            if current is None:
                _require(time.time_ns() // 1_000_000 < deadline, "recreation registration deadline expired")
                temporary = ".current-" + uuid.uuid4().hex + ".tmp"
                _new_file(public, temporary, public_files["manifest.json"], 0o444)
                os.replace(temporary, "current.json", src_dir_fd=public, dst_dir_fd=public)
            # The old fence stays authoritative until the new pointer is durable.
            os.fsync(public)
            for name, marker in (("withdrawal.json", recorded), ("withdrawn.json", completed)):
                if marker is not None:
                    os.unlink(name, dir_fd=public)
            os.fsync(public)
    except (OSError, UnicodeError):
        raise RegistrationError("recreation publication uncertain; retry the same generation") from None
    return dict(expected)


def _evidence(expected, status):
    return {key: expected[key] for key in ("app", "incarnation", "actionId", "registrationGeneration")} | {"status": status}


def observe(root, expected, private_gid, ownership=None, infrastructure=None):
    """Root-side durability barrier and validation, under the same app fence.

    It never returns secret values. `not-applied` describes the authoritative
    pointer only; it does not assert that no partial publication effects exist.
    """
    expected = _metadata(expected)
    ownership = None if ownership is None else _ownership(ownership, expected)
    infrastructure = None if infrastructure is None else _infrastructure(infrastructure, expected, ownership)
    status = "unknown"
    try:
        with _app(root, expected, private_gid) as (public, public_generations, private_generations):
            current = _pointer(public, expected["app"])
            if current != expected:
                os.fsync(public)
                return _evidence(expected, "not-applied")
            generation = expected["registrationGeneration"]
            with _dir(public_generations, generation, 0o555) as public_generation, _dir(private_generations, generation, 0o550, private_gid) as private:
                files = set(os.listdir(public_generation))
                base_files = {"manifest.json", "registration.json"}
                _require(files in (base_files, base_files | {"ownership.json"}, base_files | {"ownership.json", "infrastructure.json"}))
                _require(ownership is None or "ownership.json" in files)
                _require(infrastructure is None or "infrastructure.json" in files)
                _require(set(os.listdir(private)) == {"manifest.json", "configuration.json", "secrets"})
                _require(_metadata(_decode(_read_file(public_generation, "manifest.json", 0o444))) == expected)
                _require(_metadata(_decode(_read_file(private, "manifest.json", 0o440, private_gid))) == expected)
                registration = _registration(_decode(_read_file(public_generation, "registration.json", 0o444)), expected)
                if "ownership.json" in files:
                    _require(registration["runtime"] == "swarm")
                    published_owner = _ownership(_decode(_read_file(public_generation, "ownership.json", 0o444)), expected)
                    _require(ownership is None or ownership == published_owner)
                if "infrastructure.json" in files:
                    published_infrastructure = _infrastructure(_decode(_read_file(public_generation, "infrastructure.json", 0o444)), expected, published_owner)
                    _require(infrastructure is None or infrastructure == published_infrastructure)
                configuration = _values(_decode(_read_file(private, "configuration.json", 0o440, private_gid)))
                _require(not set(configuration).intersection(registration["secrets"]))
                with _dir(private, "secrets", 0o550, private_gid) as secret_dir:
                    _require(set(os.listdir(secret_dir)) == set(registration["secrets"]))
                    for key in registration["secrets"]:
                        _read_file(secret_dir, key, 0o440, private_gid, contents=False)
                    os.fsync(secret_dir)
                os.fsync(private)
                os.fsync(public_generation)
            os.fsync(private_generations)
            os.fsync(public_generations)
            os.fsync(public)
            status = "applied"
    except (OSError, RegistrationError, UnicodeError):
        pass
    return _evidence(expected, status)


def record_publication_evidence(root, metadata, private_gid, ownership=None, infrastructure=None):
    """Record applied evidence while the caller still holds the app fence."""
    expected = _metadata(metadata)
    evidence = observe(root, expected, private_gid, ownership, infrastructure)
    if evidence["status"] != "applied":
        return evidence
    key = hashlib.sha256(expected["app"].encode("utf8")).hexdigest()
    with _dir(root, "observations", 0o755, create=True) as observations:
        with _dir(observations, key, 0o755, create=True) as app:
            name = expected["registrationGeneration"] + ".json"
            temporary = ".observation-" + uuid.uuid4().hex + ".tmp"
            _new_file(app, temporary, _encoded(evidence), 0o444)
            os.replace(temporary, name, src_dir_fd=app, dst_dir_fd=app)
            os.fsync(app)
    return evidence
