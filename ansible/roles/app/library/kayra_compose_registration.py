#!/usr/bin/python
"""Apply a legacy Compose registration while holding the host app lock."""
import fcntl
import grp
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import tempfile

from ansible.module_utils.basic import AnsibleModule


def matches(path, content, uid, gid, mode):
    try:
        info = path.lstat()
        return (stat.S_ISREG(info.st_mode) and info.st_uid == uid and
                info.st_gid == gid and stat.S_IMODE(info.st_mode) == mode and path.read_bytes() == content)
    except FileNotFoundError:
        return False


def install(path, content, uid, gid, mode):
    if matches(path, content, uid, gid, mode):
        return
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as file:
        temporary = Path(file.name)
        try:
            os.fchown(file.fileno(), uid, gid)
            os.fchmod(file.fileno(), mode)
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def apply(module, platform, app, app_directory, registration, dotenv, lock_fd=None):
    target = platform / "apps" / (app + ".json")
    if (platform / "removing" / (app + ".json")).exists():
        module.fail_json(msg="App removal is incomplete. Complete removal before registering the app.")
    if target.exists():
        previous = json.loads(target.read_bytes())
        if not isinstance(previous, dict) or previous.get("runtime", "compose") != "compose":
            module.fail_json(msg="The existing registration does not use a supported Compose runtime.")

    deploy = pwd.getpwnam("deploy").pw_uid
    group = grp.getgrnam("deploy").gr_gid
    env_path = app_directory / ".env"
    if module.check_mode:
        module.exit_json(changed=not matches(env_path, dotenv, deploy, group, 0o644)
                         or not matches(target, registration, 0, 0, 0o644))

    app_directory.mkdir(exist_ok=True)
    os.chown(app_directory, deploy, group)
    app_directory.chmod(0o755)
    install(env_path, dotenv, deploy, group, 0o644)
    subprocess.run([str(platform / "bin" / "app-apply"), app],
                   input=module.params["secrets"].encode(), capture_output=True, check=True, pass_fds=(lock_fd,))
    install(target, registration, 0, 0, 0o644)
    module.exit_json(changed=True)


def main():
    module = AnsibleModule(
        argument_spec={
            "app": {"type": "str", "required": True},
            "apps_dir": {"type": "path", "required": True},
            "platform_dir": {"type": "path", "required": True},
            "registration": {"type": "str", "required": True},
            "dotenv": {"type": "str", "required": True},
            "secrets": {"type": "str", "required": True, "no_log": True},
        },
        supports_check_mode=True,
    )
    app = module.params["app"]
    if re.fullmatch(r"[a-z][a-z0-9-]*", app) is None:
        module.fail_json(msg="Invalid app name.")
    platform = Path(module.params["platform_dir"])
    arguments = (module, platform, app, Path(module.params["apps_dir"]) / app,
                 module.params["registration"].encode(), module.params["dotenv"].encode())
    try:
        if module.check_mode:
            apply(*arguments)
        else:
            path = platform / "removal-locks" / (app + ".lock")
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            try:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    module.fail_json(msg="Another registration, removal or purge holds the app lock.", retryable=True)
                os.fchmod(fd, 0o644)
                apply(*arguments, lock_fd=fd)
            finally:
                os.close(fd)
    except (OSError, KeyError, ValueError, subprocess.SubprocessError):
        module.fail_json(msg="Could not apply the Compose registration.")


if __name__ == "__main__":
    main()
