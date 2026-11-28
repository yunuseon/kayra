"""Sample declared maintenance and repair over HTTPS on a disposable fleet."""
import argparse
import ipaddress
import json
from pathlib import Path
import subprocess
import time


def request(address, host):
    started_at = time.time_ns() // 1_000_000
    reply = subprocess.run(
        ["curl", "--silent", "--max-time", "2", "--resolve", f"{host}:443:{address}",
         "--write-out", "\n%{http_code}", f"https://{host}/version"],
        check=False, capture_output=True, text=True, timeout=3,
    )
    completed_at = time.time_ns() // 1_000_000
    body, _, status = reply.stdout.rpartition("\n")
    release = schema = None
    if reply.returncode == 0 and status == "200":
        try:
            value = json.loads(body)
            release, schema = value["release"], value["schema"]
        except (KeyError, TypeError, ValueError):
            pass
    return {"startedAt": started_at, "completedAt": completed_at,
            "status": int(status) if status.isdigit() else None,
            "curlExit": reply.returncode, "release": release, "schema": schema}


def sample(address, host, output, timeout):
    baseline = False
    accepted = []
    failures = []
    recovered = []
    consecutive_c = 0
    first_c = None
    deadline = time.monotonic() + timeout
    with output.open("x", encoding="utf8") as requests:
        while time.monotonic() < deadline and consecutive_c < 5:
            next_sample = time.monotonic() + 1
            record = request(address, host)
            requests.write(json.dumps(record) + "\n")
            requests.flush()
            state = (record["release"], record["schema"])
            if state == ("A", 1):
                baseline = True
            if baseline:
                accepted.append(record)
                if state not in (("A", 1), ("B", 2), ("C", 2)):
                    failures.append(record)
                if state == ("C", 2):
                    if consecutive_c == 0:
                        recovered = []
                    recovered.append(record)
                    consecutive_c += 1
                    if first_c is None:
                        first_c = record["startedAt"]
                else:
                    consecutive_c = 0
            time.sleep(max(0, next_sample - time.monotonic()))
    first_failure = failures[0]["startedAt"] if failures else None
    last_failure = failures[-1]["completedAt"] if failures else None
    return {
        "passed": baseline and bool(failures) and consecutive_c >= 5,
        "scope": "One HTTPS sample per second during declared maintenance and audited forward repair.",
        "requestsSinceBaseline": len(accepted),
        "failed": len(failures),
        "firstFailedStart": first_failure,
        "lastFailedCompletion": last_failure,
        "sampledFailureSpanMs": last_failure - first_failure if failures else None,
        "firstSuccessfulRepair": first_c,
        "stableRepairStart": recovered[0]["startedAt"] if consecutive_c >= 5 else None,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("address", type=ipaddress.IPv4Address)
    parser.add_argument("host", choices=["forward.lab.test"])
    parser.add_argument("output", type=Path)
    parser.add_argument("--timeout", type=int, default=600)
    args = parser.parse_args()
    result = sample(args.address, args.host, args.output, args.timeout)
    with args.output.with_suffix(".summary.json").open("x", encoding="utf8") as summary:
        json.dump(result, summary, indent=2)
        summary.write("\n")
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
