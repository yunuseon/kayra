#!/usr/bin/env python3
"""Lab-only ext4 fault scope; never mounts or fills Docker/application storage."""
import errno
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

mode, raw_storage = sys.argv[1:]
storage = Path(raw_storage)
assert storage.is_absolute() and storage.parent == Path('/var/lib/kayra/swarm')
assert storage.name.startswith('lifecycle-storage-') and storage.resolve(strict=True) == storage
assert storage.stat().st_uid == 0 and stat.S_IMODE(storage.stat().st_mode) == 0o700
lifecycle = Path('/opt/platform/lifecycle')
image = storage / 'filesystem.ext4'
mounted = storage / 'mounted'
filler = lifecycle / '.lab-enospc-fill'


def command(*args):
    return subprocess.check_output(args, text=True).strip()


if mode == 'stage':
    assert os.getuid() == 0 and not os.path.ismount(lifecycle)
    assert lifecycle.is_dir() and not lifecycle.is_symlink()
    assert lifecycle.stat().st_uid == 1000
    assert int(command('du', '-sb', str(lifecycle)).split()[0]) < 16 * 1024 * 1024
    assert os.statvfs(storage).f_bavail * os.statvfs(storage).f_frsize > 1024 * 1024 * 1024
    with image.open('xb') as file:
        os.chmod(image, 0o600)
        file.truncate(64 * 1024 * 1024)
        file.flush()
        os.fsync(file.fileno())
    command('mkfs.ext4', '-q', '-F', '-m', '0', str(image))
    mounted.mkdir(mode=0o700)
    command('mount', '-o', 'loop,nodev,nosuid,noexec', str(image), str(mounted))
    command('cp', '-a', str(lifecycle) + '/.', str(mounted))
    os.sync()
    command('mount', '--bind', str(mounted), str(lifecycle))
    assert os.stat(lifecycle).st_dev == os.stat(mounted).st_dev
elif mode in ('fill', 'release'):
    assert os.getuid() == 0 and os.path.ismount(lifecycle)
    assert os.stat(lifecycle).st_dev == os.stat(mounted).st_dev
    assert command('findmnt', '-n', '-o', 'FSTYPE', '--target', str(lifecycle)) == 'ext4'
    assert stat.S_ISREG(image.stat().st_mode) and image.stat().st_size == 64 * 1024 * 1024
    if mode == 'release':
        assert filler.lstat().st_uid == 1000 and stat.S_ISREG(filler.lstat().st_mode)
        filler.unlink()
        os.sync()
    else:
        os.setgroups([])
        os.setgid(1000)
        os.setuid(1000)
        written = 0
        file = os.open(filler, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            try:
                while True:
                    written += os.write(file, b'x' * 65536)
            except OSError as error:
                assert error.errno == errno.ENOSPC
            try:
                os.fsync(file)
            except OSError as error:
                assert error.errno == errno.ENOSPC
        finally:
            os.close(file)
        assert written < 64 * 1024 * 1024
else:
    raise ValueError('unknown fault mode')

space = os.statvfs(lifecycle)
print(json.dumps({'mode': mode, 'storage': str(storage), 'imageBytes': 64 * 1024 * 1024,
                  'filesystem': command('findmnt', '-n', '-o', 'SOURCE,FSTYPE', '--target', str(lifecycle)),
                  'availableBytes': space.f_bavail * space.f_frsize, 'uid': os.getuid()}))
