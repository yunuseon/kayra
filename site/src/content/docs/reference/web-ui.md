---
title: Web interface
description: kayra ui, the fleet in the browser on the operator's machine.
---

`kayra ui` serves a web interface for the fleet from the operator's machine. It
shows the same fleet as the command line and runs the same commands through
the same plans and guards. It is a view of the CLI, not a second control plane.

```bash
kayra ui                         # opens the browser
kayra ui --port 7700 --no-open   # prints the URL instead
```

## What it shows

- **Fleet:** every server as a card: kind, target, domain, its address, and
  live answers from SSH and, on platform servers, the login (Authelia), as
  `kayra status` asks them.
- **A server:** the same facts, its apps, the commands it offers (deploy,
  apps, verify, setup, plan, …, down), and the runs started from here.
- **An app:** its runs on the server (state, commit, why, when, how long),
  its releases with the live one marked and a rollback for each other one,
  and a run's log with errors and warnings marked. Deploy a branch, tag or
  commit from here.
- **Validate** and **Doctor:** `kayra validate`'s findings per server, and
  `kayra doctor`'s checks as a run.
- **⌘K:** go to any page, server or app, or run any command, by typing a few
  letters.

## Running a command

Every command opens as its plan first: each step under its part, with the
command it runs, as `--dry-run` shows it. **Run** starts it. Then the run's
page shows:
- each step as it runs, with its time
- its output, Ansible's colours included
- a failed step opened, with what it said
- the footer naming the command that reruns a failed part alone

**Stop** sends the running program SIGINT, as Ctrl-C does on the terminal.

- One run at a time per server: a second on the same server is refused until the first has ended.
- Before a change to a server that is not a Multipass VM, kayra asks for the
  server's name, and it checks that on the server side too. `kayra down`'s own
  confirmation comes on top.
- Hetzner and home servers still change only from a clean `main` with the
  pinned kayra: the plans carry the same guards.
- A server whose vault password is asked on a terminal (no
  `vault_password_file`) runs nothing that opens its secrets from the browser.
- Each run is recorded as JSON lines in the fleet's `.cache/ui/runs/`; the
  Runs page lists them after a restart too.

## Who gets in

It listens on 127.0.0.1 only. The URL it prints carries a token made for this
launch, which the browser exchanges for a cookie. Every request must name this
listener as its host, so no other site can reach it through DNS rebinding.
Every write must come from its own origin, and every API call must carry the
token. Stopping `kayra ui` stops whatever it runs.

For an AI agent working in a fleet, starting `kayra ui` asks the operator
first: commands run from the browser are out of the agent guard's sight.
