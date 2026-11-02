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
import uuid
from urllib.parse import urlsplit

MAX_BYTES = 1024 * 1024
MAX_FILE_BYTES = 64 * 1024
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


def _encoded(value):
    try:
        data = json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("ascii")
    except (TypeError, ValueError, OverflowError):
        raise RegistrationError("invalid registration payload") from None
    _require(len(data) <= MAX_FILE_BYTES, "registration payload too large")
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
    _require(type(value) is dict and set(value) == {"name", "repo", "ref", "path", "runtime", "hosts", "secrets"})
    _require(value["name"] == metadata["app"] and value["runtime"] == "compose")
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


def _read_file(parent, name, mode, gid=0, contents=True):
    fd = os.open(name, _FILE_FLAGS, dir_fd=parent)
    try:
        info = _check(fd, mode, gid, False)
        _require(info.st_size <= MAX_FILE_BYTES, "registration file too large")
        if contents:
            data = bytearray()
            while True:
                chunk = os.read(fd, min(8192, MAX_FILE_BYTES + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
                _require(len(data) <= MAX_FILE_BYTES, "registration file too large")
            result = bytes(data)
        else:
            result = None
        os.fsync(fd)
        return result
    finally:
        os.close(fd)


@contextlib.contextmanager
def _app(root, metadata, private_gid, create=False):
    info = os.fstat(root)
    _require(sys.platform == "linux" and os.geteuid() == 0 and stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not (info.st_mode & 0o022), "untrusted registration root")
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


def publish(root, metadata, registration, configuration, secrets, private_gid, previous=None):
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
    registration = _registration(registration, expected)
    configuration, secrets = _values(configuration), _values(secrets)
    _require(set(secrets) == set(registration["secrets"]) and not set(configuration).intersection(secrets), "registration keys do not match")
    metadata_bytes, registration_bytes, config_bytes = _encoded(expected), _encoded(registration), _encoded(configuration)
    _require(sum(len(value.encode("utf8")) for value in secrets.values()) + len(config_bytes) + len(registration_bytes) <= MAX_BYTES, "registration payload too large")
    generation = expected["registrationGeneration"]
    try:
        with _app(root, expected, private_gid, create=True) as (public, public_generations, private_generations):
            _require(_pointer(public, expected["app"]) == previous, "registration pointer changed")
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


def _evidence(expected, status):
    return {key: expected[key] for key in ("app", "incarnation", "actionId", "registrationGeneration")} | {"status": status}


def observe(root, expected, private_gid):
    """Root-side durability barrier and validation, under the same app fence.

    It never returns secret values. `not-applied` describes the authoritative
    pointer only; it does not assert that no partial publication effects exist.
    """
    expected = _metadata(expected)
    status = "unknown"
    try:
        with _app(root, expected, private_gid) as (public, public_generations, private_generations):
            current = _pointer(public, expected["app"])
            if current != expected:
                os.fsync(public)
                return _evidence(expected, "not-applied")
            generation = expected["registrationGeneration"]
            with _dir(public_generations, generation, 0o555) as public_generation, _dir(private_generations, generation, 0o550, private_gid) as private:
                _require(set(os.listdir(public_generation)) == {"manifest.json", "registration.json"})
                _require(set(os.listdir(private)) == {"manifest.json", "configuration.json", "secrets"})
                _require(_metadata(_decode(_read_file(public_generation, "manifest.json", 0o444))) == expected)
                _require(_metadata(_decode(_read_file(private, "manifest.json", 0o440, private_gid))) == expected)
                registration = _registration(_decode(_read_file(public_generation, "registration.json", 0o444)), expected)
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
