---
title: Web interface
description: kayra serve, the fleet in the browser on the operator's machine.
---

`kayra serve` serves a web interface for the fleet from the operator's machine. It
shows the same fleet as the command line and runs the same commands through
the same plans and guards. It is a view of the CLI, not a second control plane.

```bash
kayra serve                         # opens the browser
kayra serve --port 7700 --no-open   # prints the URL instead
kayra serve --ui --api              # browser and local program API
```

It looks like a terminal on purpose: commands, names and logs in a monospaced
face, sentences meant for a person in a proportional one, and every state said
by a word and a glyph, not by colour alone (`[  OK  ]`, `[BEHIND]`, ✓, ✕, ▲).
It comes in a dark and a light theme: it follows the system until the toggle
in the top bar picks one, which this browser then keeps. A status line at the
bottom says which fleet and kayra this is and how many servers answer.

## What it shows

- **Fleet:** a row per server with its state in brackets, kind, target,
  domain, its address, live answers from SSH and, on platform servers, the
  login (Authelia), which kayra set it up (marked where it is not the fleet's
  pin), as `kayra status` asks them, its last runs from here as a strip, and
  `plan` and `deploy` or `setup` beside it. Above them a few totals; below, the
  journal of recent runs and **needs you**: servers that do not answer, SSH
  that is off, servers behind the pin (with the command that records it), last
  runs that failed, and runs still going.
- **A server:** the same facts, the same notes for it alone, its apps, the
  commands it offers (deploy, apps, verify, setup, plan, …, down), and the
  runs started from here.
- **An app:** its runs on the server (state, commit, why, when, how long),
  its releases with the live one marked and a rollback for each other one,
  and a run's log with errors and warnings marked. Deploy a branch, tag or
  commit from here.
- **Validate** and **Doctor:** `kayra validate`'s findings per server, and
  `kayra doctor`'s checks as a run.
- **⌘K:** go to any page, server or app, or run any command, by typing a few
  letters.
- **SSH terminal:** an interactive SSH session with terminal input and output.
  The Runs page links back to open and finished sessions.

## Running a command

Commands open a form generated from the operation catalog. Server and app
pickers use the fleet; removed app names can still be entered. For `app check`,
enter a repository path or browse local directories. Paths resolve on the
machine running `kayra serve`, relative to the fleet.

Plans and SSH sessions show their steps before starting. **Verbose output**
enables Ansible's full output; **Dry run** shows the plan without running it.
Status offers **offline**, and the Renovate job offers **noPrs**. Array inputs,
including SSH command arguments, take one item per line and preserve spaces
within each item. Queries show their answers in the form.

The plan lists each step with a glyph for its kind: ◆ a guard that stops the
plan, ◇ a check, ? a confirmation, ❯ a run. **Run** starts it; on a real
server the button reads **approve · kayra deploy alaz** and stays off until
the server's name is typed. Then the run's page shows:
- a bar with a segment per step, and the time it has taken
- the steps beside the log, each with its state and time; choosing one shows
  only its output
- the log as the terminal prints it, Ansible's colours included, following
  new output until you scroll up
- where it stopped and why, when it failed or was stopped
- the footer naming the command that reruns a failed part alone

**Stop** sends the running program SIGINT, as Ctrl-C does on the terminal.

- One run at a time per server: a second on the same server is refused until the first has ended.
- Before a change to a server that is not a Multipass VM, kayra asks for the
  server's name, and it checks that on the server side too. `kayra down`'s own
  confirmation comes on top.
- Hetzner and home servers still change only from a clean `main` with the
  pinned kayra: the plans carry the same guards.
- Vault and sudo passwords use password fields. Answers are cleared after
  submission and never enter the run record.
- Each run is recorded as JSON lines in the fleet's `.cache/ui/runs/`; the
  Runs page lists them after a restart too.

SSH opens a terminal with 120 columns and 32 rows. Leaving its page keeps the
session open; **Close session** disconnects it. A reload reconnects to an open
session and replays its output. Input requests are sent in order and are not
stored separately; output, including anything echoed by the shell, is recorded.

## Who gets in

It listens on 127.0.0.1 only. The URL it prints carries a token made for this
launch, which the browser exchanges for a cookie. Every request must name this
listener as its host, so no other site can reach it through DNS rebinding.
Cookie-authenticated writes must come from its own origin. With `--api`, local
programs can use a bearer token from the private discovery file; these requests
need no Origin. See the [local API reference](../api/). Stopping `kayra serve`
stops whatever it runs.

For an AI agent working in a fleet, starting `kayra serve` asks the operator
first: commands run from the browser are out of the agent guard's sight.
