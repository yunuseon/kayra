#!/usr/bin/env python3
"""Isolated Linux experiment, not a platform publisher or security boundary.

The supplied root fd and its ancestors are trusted; no untrusted principal can
rename entries in the root or in either generations directory. The reader must
follow current.json and use the same ownership model. No live Kayra paths.
"""
import json
import os
import re
import stat

_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")


def _directory(parent, name, mode):
    fd = os.open(name, _FLAGS, dir_fd=parent)
    info = os.fstat(fd)
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != mode:
        os.close(fd)
        raise ValueError("untrusted directory owner or mode")
    return fd


def _write_new(parent, name, payload, mode):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode, dir_fd=parent)
    try:
        os.fchmod(fd, mode)
        data = memoryview(payload)
        while data:
            count = os.write(fd, data)
            if count <= 0:
                raise OSError("incomplete write")
            data = data[count:]
        os.fsync(fd)
    except BaseException:
        os.close(fd)
        os.unlink(name, dir_fd=parent)
        raise
    else:
        os.close(fd)


def bootstrap(root):
    """Initialize an empty trusted root; never follows pre-existing symlinks."""
    for name, mode in (("public", 0o755), ("private", 0o700)):
        try:
            os.mkdir(name, mode, dir_fd=root)
            os.fsync(root)
        except FileExistsError:
            pass
        fd = _directory(root, name, mode)
        try:
            try:
                os.mkdir("generations", mode, dir_fd=fd)
                os.fsync(fd)
            except FileExistsError:
                pass
            child = _directory(fd, "generations", mode)
            os.close(child)
        finally:
            os.close(fd)


def publish(root, generation, public, private, checkpoint=lambda _name: None):
    """Create a generation once, then atomically replace the public pointer.

    Trusted callers must keep private values out of public input. An exception
    during or after pointer replacement is uncertain; the generation is retained.
    The callback is an injectable test barrier, not a production API.
    """
    if not isinstance(generation, str) or not _ID.fullmatch(generation):
        raise ValueError("invalid generation")
    public_bytes = json.dumps(public, sort_keys=True, separators=(",", ":")).encode()
    private_bytes = json.dumps(private, sort_keys=True, separators=(",", ":")).encode()
    public_dir = _directory(root, "public", 0o755)
    private_dir = public_generations = private_generations = -1
    created = []
    committed = False
    pointer_owned = False
    pointer_tmp = f".current-{generation}.tmp"
    try:
        private_dir = _directory(root, "private", 0o700)
        public_generations = _directory(public_dir, "generations", 0o755)
        private_generations = _directory(private_dir, "generations", 0o700)
        for parent, mode, name, data in (
            (private_generations, 0o700, "secrets.json", private_bytes),
            (public_generations, 0o755, "registration.json", public_bytes),
        ):
            os.mkdir(generation, mode, dir_fd=parent)
            created.append((parent, name))
            generation_dir = _directory(parent, generation, mode)
            try:
                _write_new(generation_dir, name, data, 0o600 if name == "secrets.json" else 0o644)
                os.fsync(generation_dir)
            finally:
                os.close(generation_dir)
            os.fsync(parent)
            checkpoint("private" if name == "secrets.json" else "public")
        _write_new(public_dir, pointer_tmp, json.dumps({"generation": generation}).encode(), 0o644)
        pointer_owned = True
        checkpoint("before-pointer")
        # A rename can have taken effect even if its acknowledgement is lost.
        committed = True
        os.replace(pointer_tmp, "current.json", src_dir_fd=public_dir, dst_dir_fd=public_dir)
        pointer_owned = False
        checkpoint("after-pointer")
        os.fsync(public_dir)
    finally:
        if pointer_owned:
            try:
                os.unlink(pointer_tmp, dir_fd=public_dir)
            except FileNotFoundError:
                pass
        if not committed:
            for parent, name in reversed(created):
                generation_dir = _directory(parent, generation, 0o700 if name == "secrets.json" else 0o755)
                try:
                    try:
                        os.unlink(name, dir_fd=generation_dir)
                    except FileNotFoundError:
                        pass
                finally:
                    os.close(generation_dir)
                os.rmdir(generation, dir_fd=parent)
                os.fsync(parent)
        for fd in (public_generations, private_generations, public_dir, private_dir):
            if fd >= 0:
                os.close(fd)
