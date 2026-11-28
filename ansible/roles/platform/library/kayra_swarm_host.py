#!/usr/bin/python
"""Explicit single-node platform setup; never adopts or leaves an unmanaged Swarm."""
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import uuid


class HostError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise HostError(message)


def profile(value):
    fields = {"enabled", "advertise_address", "memory_bytes", "cpu_millicores", "platform_memory_bytes", "platform_cpu_millicores"}
    require(type(value) is dict and set(value) == fields and value["enabled"] is True, "explicit complete experimental Swarm profile required")
    try:
        require(type(value["advertise_address"]) is str and str(ipaddress.IPv4Address(value["advertise_address"])) == value["advertise_address"], "invalid Swarm advertise address")
    except ipaddress.AddressValueError:
        raise HostError("invalid Swarm advertise address") from None
    for key in fields - {"enabled", "advertise_address"}:
        require(type(value[key]) is int and 0 < value[key] <= 2**53 - 1, "invalid declared Swarm resource budget")
    require(value["platform_memory_bytes"] < value["memory_bytes"] and value["platform_cpu_millicores"] < value["cpu_millicores"], "platform overhead must leave workload capacity")
    return dict(value)


def docker(args):
    result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=90, check=False)
    require(result.returncode == 0, "Docker host setup command failed; inspect runtime state before retrying")
    return result.stdout


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def trusted_directory(directory, create=False):
    require(directory.is_absolute(), "Swarm authority path must be absolute")
    for path in [*reversed(directory.parents), directory]:
        if not path.exists() and create:
            path.mkdir(mode=0o755)
            sync_directory(path.parent)
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_gid == 0 and not stat.S_IMODE(info.st_mode) & 0o022, "untrusted Swarm authority directory")


def read(path, mode):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_gid == 0 and stat.S_IMODE(info.st_mode) == mode and info.st_nlink == 1 and info.st_size <= 65536, "invalid Swarm authority file")
        with os.fdopen(os.dup(fd), "rb") as stream:
            data = stream.read(65537)
        require(len(data) == info.st_size, "Swarm authority changed during read")
        return json.loads(data)
    finally:
        os.close(fd)


def write(path, value, mode):
    temporary = path.parent / (".swarm-" + str(uuid.uuid4()) + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(os.dup(fd), "w", encoding="utf8") as stream:
            json.dump(value, stream, sort_keys=True, separators=(",", ":"))
            stream.flush()
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temporary, path)
    sync_directory(path.parent)


def identity(value):
    return type(value) is str and re.fullmatch(r"[a-z0-9]{25}", value) is not None


def validate_swarm(swarm, state):
    require(swarm["LocalNodeState"] == "active" and swarm.get("ControlAvailable") is True and swarm.get("Managers") == 1 and swarm.get("Nodes") == 1, "experimental Swarm requires one healthy manager and no other nodes")
    require(identity(swarm.get("NodeID")) and identity(swarm.get("Cluster", {}).get("ID")), "invalid Docker Swarm identity")
    if state["node"] is not None:
        require(state["node"] == swarm["NodeID"] and state["cluster"] == swarm["Cluster"]["ID"], "Docker Swarm ownership changed; intervention required")


def validate_network(network, state):
    require(state is not None and network.get("Driver") == "overlay" and network.get("Scope") == "swarm" and network.get("Attachable") is True and network.get("Ingress") is False and identity(network.get("Id")) and network.get("Labels", {}).get("io.kayra.swarm-owner") == state["owner"], "platform-swarm is not the owned attachable overlay")
    if state["network"] is not None:
        require(state["network"] == network["Id"], "platform Swarm network identity changed; intervention required")


def ensure(directory, requested, check=False, run=docker, migration_timeout_seconds=90):
    require(os.geteuid() == 0, "Swarm host setup requires root")
    if not requested:
        if directory.exists() or directory.is_symlink():
            trusted_directory(directory)
            require(not any((directory / name).exists() or (directory / name).is_symlink() for name in ("state.json", "authority.json", "policy")), "experimental Swarm is already provisioned; keep its profile until an explicit retirement operation")
        return {"changed": False, "enabled": False}
    desired = profile(requested)
    require(type(migration_timeout_seconds) is int and 1 <= migration_timeout_seconds <= 86400, "invalid host migration timeout ceiling")
    if check:
        if directory.exists() or directory.is_symlink():
            trusted_directory(directory)
        policy_changed = migration_policy(directory, migration_timeout_seconds, True)
        result = reconcile(directory, desired, True, run)
        return {**result, "changed": result["changed"] or policy_changed}
    trusted_directory(directory, create=True)
    fd = os.open(directory / "writer.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        lock = os.fstat(fd)
        require(stat.S_ISREG(lock.st_mode) and lock.st_uid == 0 and lock.st_gid == 0 and stat.S_IMODE(lock.st_mode) == 0o600 and lock.st_nlink == 1, "invalid Swarm host lock")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise HostError("another platform setup owns the Swarm host lock") from None
        migration_policy(directory, migration_timeout_seconds, True)
        result = reconcile(directory, desired, False, run)
        policy_changed = migration_policy(directory, migration_timeout_seconds, False)
        return {**result, "changed": result["changed"] or policy_changed}
    finally:
        os.close(fd)


def migration_policy(directory, seconds, check):
    public = directory / "policy"
    if public.exists() or public.is_symlink() or not check:
        trusted_directory(public, create=not check)
    path = public / "migration.json"
    previous = read(path, 0o444) if path.exists() or path.is_symlink() else None
    require(previous is None or type(previous) is dict and set(previous) == {"version", "migrationTimeoutCeilingSeconds"} and type(previous["version"]) is int and previous["version"] == 1 and type(previous["migrationTimeoutCeilingSeconds"]) is int and 1 <= previous["migrationTimeoutCeilingSeconds"] <= 86400, "invalid published migration policy; intervention required")
    desired = {"version": 1, "migrationTimeoutCeilingSeconds": seconds}
    changed = previous != desired
    if changed and not check:
        write(path, desired, 0o444)
    return changed


def reconcile(directory, desired, check, run):
    state_path = directory / "state.json"
    public_path = directory / "authority.json"
    state = read(state_path, 0o600) if state_path.exists() or state_path.is_symlink() else None
    if state is not None:
        require(type(state) is dict and set(state) == {"version", "profile", "owner", "phase", "node", "cluster", "network"} and state["version"] == 1 and state["phase"] in ("initializing", "ready"), "invalid Swarm setup state")
        require(state["profile"] == desired, "Swarm host profile changes require an explicit maintenance operation")
        require(type(state["owner"]) is str and str(uuid.UUID(state["owner"])) == state["owner"], "invalid Swarm owner identity")
        require(all(state[key] is None or identity(state[key]) for key in ("node", "cluster", "network")), "invalid recorded Swarm identity")
        require(state["phase"] != "ready" or all(identity(state[key]) for key in ("node", "cluster", "network")), "incomplete Swarm setup state")
    else:
        require(not public_path.exists() and not public_path.is_symlink(), "Swarm authority exists without setup state; intervention required")
    info = json.loads(run(["info", "--format", "{{json .}}"]))
    swarm = info["Swarm"]
    require(desired["memory_bytes"] <= info["MemTotal"] and desired["cpu_millicores"] <= info["NCPU"] * 1000, "declared Swarm capacity exceeds the Docker host")
    active = swarm["LocalNodeState"] == "active"
    require(swarm["LocalNodeState"] in ("active", "inactive"), "Swarm membership is not ready; intervention required")
    require(state is not None or not active, "refusing to adopt an existing unmanaged Swarm")
    require(state is None or state["node"] is None or active, "owned Swarm membership disappeared; intervention required")
    networks = [json.loads(line) for line in run(["network", "ls", "--no-trunc", "--format", "{{json .}}"]).splitlines() if line.strip()]
    matching = [item for item in networks if item["Name"] == "platform-swarm"]
    require(len(matching) <= 1, "ambiguous platform Swarm network")
    network = json.loads(run(["network", "inspect", matching[0]["ID"]]))[0] if matching else None
    if network is not None:
        validate_network(network, state)
    require(state is None or state["phase"] != "ready" or network is not None, "owned Swarm network disappeared; intervention required")
    if check:
        if active:
            validate_swarm(swarm, state)
        public = read(public_path, 0o444) if public_path.exists() or public_path.is_symlink() else None
        expected = None if state is None or state["phase"] != "ready" else authority_for(state, desired)
        return {"changed": state is None or state["phase"] != "ready" or public != expected, "enabled": True}
    changed = False
    if state is None:
        state = {"version": 1, "profile": desired, "owner": str(uuid.uuid4()), "phase": "initializing", "node": None, "cluster": None, "network": None}
        write(state_path, state, 0o600)
        changed = True
    if not active:
        run(["swarm", "init", "--advertise-addr", desired["advertise_address"], "--listen-addr", desired["advertise_address"] + ":2377"])
        swarm = json.loads(run(["info", "--format", "{{json .}}"]))["Swarm"]
        changed = True
    validate_swarm(swarm, state)
    if state["node"] is None:
        state = {**state, "node": swarm["NodeID"], "cluster": swarm["Cluster"]["ID"]}
        write(state_path, state, 0o600)
        changed = True
    if network is None:
        run(["network", "create", "--driver", "overlay", "--attachable", "--label", "io.kayra.swarm-owner=" + state["owner"], "platform-swarm"])
        network = json.loads(run(["network", "inspect", "platform-swarm"]))[0]
        validate_network(network, state)
        changed = True
    if state["phase"] != "ready":
        state = {**state, "phase": "ready", "network": network["Id"]}
        write(state_path, state, 0o600)
        changed = True
    authority = authority_for(state, desired)
    if not (public_path.exists() or public_path.is_symlink()) or read(public_path, 0o444) != authority:
        write(public_path, authority, 0o444)
        changed = True
    return {"changed": changed, "enabled": True, "authority": authority}


def authority_for(state, desired):
    return {"version": 1, "profile": desired, "node": state["node"], "cluster": state["cluster"], "network": {"name": "platform-swarm", "id": state["network"]}}


def main():
    from ansible.module_utils.basic import AnsibleModule
    module = AnsibleModule(argument_spec={"directory": {"type": "path", "default": "/var/lib/kayra/swarm"}, "profile": {"type": "dict", "default": {}}, "migration_timeout_seconds": {"type": "int", "default": 90}}, supports_check_mode=True)
    try:
        module.exit_json(**ensure(Path(module.params["directory"]), module.params["profile"], module.check_mode, migration_timeout_seconds=module.params["migration_timeout_seconds"]))
    except HostError as error:
        module.fail_json(msg=str(error))
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        module.fail_json(msg="Swarm host setup refused; preserve its authority directory and inspect Docker membership and network state")


if __name__ == "__main__":
    main()
