#!/usr/bin/env python3
"""Disposable-host integration fixture, not an application deployment path."""
import argparse
import http.client
import json
from pathlib import Path
import re
import socket
import ssl
import subprocess
import time
import urllib.error
import urllib.request


def command(*args):
    result = subprocess.run(["docker", *args], check=True, capture_output=True, text=True, timeout=90)
    return result.stdout.strip()


def status(url, method="GET"):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=b"{}" if method == "POST" else None, method=method, headers={"Content-Type": "application/json"}), timeout=5) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def request(address, hostname, context):
    connection = http.client.HTTPConnection(address, 443, timeout=2)
    connection.sock = context.wrap_socket(socket.create_connection((address, 443), timeout=2), server_hostname=hostname)
    try:
        connection.request("GET", "/", headers={"Host": hostname, "Connection": "close"})
        response = connection.getresponse()
        body = response.read(65536)
        if response.status != 200:
            raise RuntimeError("routed fixture did not return HTTP 200")
        return body.decode("utf8")
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--address", required=True)
    parser.add_argument("--domain", required=True)
    parser.add_argument("--ca", required=True)
    args = parser.parse_args()
    authority = json.loads(Path("/var/lib/kayra/swarm/authority.json").read_text())
    info = json.loads(command("info", "--format", "{{json .}}"))
    assert authority["node"] == info["Swarm"]["NodeID"]
    assert authority["cluster"] == info["Swarm"]["Cluster"]["ID"]
    network = json.loads(command("network", "inspect", "platform-swarm"))[0]
    assert authority["network"]["id"] == network["Id"] and network["Attachable"]
    policy = json.loads(Path("/var/lib/kayra/swarm/policy/migration.json").read_text())
    deployers = command("ps", "-q", "--filter", "label=com.docker.compose.project=platform", "--filter", "label=com.docker.compose.service=deployer", "--filter", "label=com.docker.compose.oneoff=False").splitlines()
    assert len(deployers) == 1
    deployer = json.loads(command("inspect", deployers[0]))[0]
    assert any(item["Destination"] == "/run/kayra-platform/policy" and not item["RW"] for item in deployer["Mounts"])
    reader = "import {existsSync} from 'node:fs'; const base='/opt/kayra/server/platform/migration-policy'; const {readMigrationPolicy}=await import(base+(existsSync(base+'.ts')?'.ts':'.js')); const result=await readMigrationPolicy(process.env.KAYRA_MIGRATION_POLICY); if(!result.ok) throw new Error(result.error); console.log(JSON.stringify(result.value));"
    assert json.loads(command("exec", deployers[0], "node", "--input-type=module", "--eval", reader)) == policy
    proxy_id = command("ps", "-q", "--filter", "label=com.docker.compose.project=platform", "--filter", "label=com.docker.compose.service=socket-proxy")
    proxy = json.loads(command("inspect", proxy_id))[0]
    assert "POST=0" in proxy["Config"]["Env"]
    base = "http://" + proxy["NetworkSettings"]["Networks"]["platform-socket"]["IPAddress"] + ":2375"
    reads = {endpoint: status(base + endpoint) for endpoint in ("/version", "/services", "/tasks", "/networks", "/nodes")}
    writes = {method + " " + endpoint: status(base + endpoint, method) for method, endpoint in (("POST", "/containers/create"), ("POST", "/services/create"), ("DELETE", "/services/nonexistent-kayra-lab-service"))}
    assert all(code == 200 for code in reads.values()), reads
    assert all(code == 403 for code in writes.values()), writes
    containers = command("ps", "-q", "--filter", "label=com.docker.compose.project=sample").splitlines()
    assert len(containers) == 1
    legacy = json.loads(command("inspect", containers[0]))[0]
    images = json.loads(command("image", "inspect", legacy["Image"]))[0]["RepoDigests"]
    image = next(ref for ref in images if re.fullmatch(r"localhost:5000/sample/[a-z0-9._/-]+@sha256:[0-9a-f]{64}", ref))
    name = "kayra-lab-platform-http"
    assert not command("service", "ls", "-q", "--filter", "name=" + name), "fixture service already exists; preserve and inspect it"
    context = ssl.create_default_context(cafile=args.ca)
    expected = request(args.address, "www." + args.domain, context)
    labels = {
        "io.kayra.lab": "swarm-platform", "io.kayra.lab-node": authority["node"],
        "traefik.enable": "true", "traefik.swarm.lbswarm": "true", "traefik.swarm.network": "platform-swarm",
        "traefik.http.routers.kayra-lab-swarm.rule": "Host(`swarm." + args.domain + "`)",
        "traefik.http.routers.kayra-lab-swarm.entrypoints": "websecure",
        "traefik.http.routers.kayra-lab-swarm.tls.certresolver": "le",
        "traefik.http.services.kayra-lab-swarm.loadbalancer.server.port": "8080",
    }
    service = command("service", "create", "--detach=true", "--no-resolve-image", "--name", name, "--replicas", "1", "--network", "platform-swarm",
        "--limit-memory", "32m", "--reserve-memory", "16m", "--limit-cpu", "0.1", "--reserve-cpu", "0.05",
        "--health-cmd", "wget -q -O /dev/null http://127.0.0.1:8080/", "--health-interval", "1s", "--health-timeout", "1s", "--health-retries", "3",
        "--update-order", "start-first", "--update-monitor", "30s", "--update-failure-action", "rollback", "--stop-grace-period", "30s",
        *[argument for key, value in labels.items() for argument in ("--label", key + "=" + value)], image)
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try:
            if request(args.address, "swarm." + args.domain, context) == expected:
                break
        except (OSError, RuntimeError):
            pass
        time.sleep(1)
    else:
        raise RuntimeError("Swarm fixture did not route within 90 seconds; preserved service " + service)
    for _ in range(10):
        assert request(args.address, "swarm." + args.domain, context) == expected
        assert request(args.address, "www." + args.domain, context) == expected
    traefik = command("ps", "-q", "--filter", "label=com.docker.compose.project=platform", "--filter", "label=com.docker.compose.service=traefik")
    traefik_image = json.loads(command("inspect", traefik))[0]["Config"]["Image"]
    assert not json.loads(command("service", "inspect", service))[0].get("Endpoint", {}).get("Ports", [])
    command("service", "rm", service)
    print(json.dumps({"engine": info["ServerVersion"], "cli": json.loads(command("version", "--format", "{{json .Client}}"))["Version"],
        "compose": command("compose", "version", "--short"), "os": info["OperatingSystem"], "traefik": traefik_image,
        "migrationPolicy": policy, "socketProxy": proxy["Config"]["Image"], "fixtureImage": image, "authority": authority,
        "readEndpoints": reads, "writeEndpoints": writes, "swarmRequests": 10, "composeRequests": 10, "tlsVerified": True}, sort_keys=True))


if __name__ == "__main__":
    main()
