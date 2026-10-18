---
title: CLI
description: Every kayra command.
---

Run from anywhere inside a fleet. Server and app names complete in the shell.
Every command takes `--dry-run`: it prints the plan — each command, guard and
confirmation, with its environment — and runs nothing. On a terminal each step
is numbered under its title, paths named by their root (`<kayra>`, `<fleet>`,
`~`); piped, it prints one plain, copyable line per step.

## What you see

```
kayra deploy shop-prod · platform on hetzner · shop.example.com · kayra 1.2.3 · 9 steps

setup
  ✓ shop-prod may be changed from this checkout                             0.3s
  ✓ Ansible collections                                                     1.2s
  ◆ Host layer · platform.yml                                                3/9
  …the playbook's own output…
  ✓ Host layer · platform.yml                                              2m03s
…
✗ kayra deploy shop-prod failed at Verify · step 9 of 9 · 4m12s
  → kayra verify shop-prod runs just this part
```

- **A heading, then each step** with its time; a command made of several
  (`up`, `deploy`) groups its steps by the command that runs each part alone,
  and when one fails, the footer names it.
- **stdout is the output, stderr what is around it:** the heading, the steps
  and the footer go to stderr, so `kayra doctor > report` keeps only the
  report. `ssh` and the `app` and `job` commands print the server's answer and
  nothing else.
- **The deployer's answers are drawn**, not passed through: `app runs` as a
  table, `app rollback` without a commit as the releases with the live one
  marked, `app logs` with errors and warnings marked on a terminal (piped, the
  log byte for byte). A server not yet deployed with the kayra you run answers
  `app runs` the old way, printed as it came, and refuses `app rollback`'s list
  (`--json is not an earlier release`) until its `kayra deploy`.
- **Colors** follow `FORCE_COLOR`, then `NO_COLOR`, then whether the output is a
  terminal. On one, quiet steps (guards, checks) show a spinner and a running
  time, the window title follows the step, and a run longer than 30 seconds
  ends with a notification where the terminal shows them (iTerm2, WezTerm,
  Ghostty; Ghostty and WezTerm also show a progress bar).
- **Ctrl-C** reaches the step's program; kayra stops once it has given up and
  says where (exit status 130). A second Ctrl-C does not wait.

## Per server

| Command | What it does |
|---|---|
| `kayra up <server>` | Provision, set up everything, point `/etc/hosts` at it (multipass) |
| `kayra provision <server>` | Create or update the machine (target home: build the image to import) |
| `kayra deploy <server>` | Host setup and every app, no provisioning |
| `kayra setup <server>` | The host layer only: the playbook for the server's kind |
| `kayra verify <server>` | Whether a platform server works as its users see it: logins, real certificates, a refused unsigned webhook, every app hostname, the registrations, containers, last runs and open alerts. `deploy` and `up` run it at the end |
| `kayra plan <server>` | What `provision` and `setup` would change, changing nothing: OpenTofu's plan and the playbook in check mode with diffs (files holding secrets only say that they would change). Works from any branch |
| `kayra apps <server>` | Make the server's apps match `server.yml`: register each, remove the rest (data kept) |
| `kayra hosts <server>` | Point the domain at a multipass VM in `/etc/hosts` (sudo) |
| `kayra ssh <server> [-- <command>]` | SSH into the server, or run a command there |
| `kayra down <server>` | Destroy the machine (asks for the name on a Hetzner server) |
| `kayra adopt <server>` | Once, for a server not created by kayra: add the `deploy` user as root |
| `kayra backup test <server>` | Restore the latest backup to a scratch dir, check it, delete it — started on the server, followed over SSH |
| `kayra app purge <server> <app>` | Delete a removed app's volumes: its data, irreversibly |

Hetzner and home servers change only from a clean `main` equal to its remote,
with the kayra release the fleet pins (not a linked checkout): `provision`,
`adopt`, `setup`, `apps` and `app purge` refuse anything else.

## Apps on a server

Through the server's deployer, over SSH; platform servers only.

```
$ kayra app runs shop-prod shop
shop on shop-prod · live a1b2c3d since 2h ago

  STATE      COMMIT   WHY     WHEN     TOOK   RUN
  ◆ running  —        deploy  12s ago  12s…   20261018T115948Z-77aa00
  ✓ success  a1b2c3d  push    2h ago   1m12s  20261018T095848Z-0f9e8d
  ✗ failure  9f8e7d6  poll    26h ago  48s    20261017T091700Z-ab12cd

  → kayra app logs shop-prod shop [RUN] shows a run's log, the newest by default

$ kayra app rollback shop-prod shop
shop on shop-prod · 2 releases

    COMMIT   DEPLOYED
  ● a1b2c3d  2h ago    live
    9f8e7d6  2d ago

  → kayra app rollback shop-prod shop 9f8e7d6 deploys that one again
```

| Command | What it does |
|---|---|
| `kayra app runs <server> <app>` | What runs now, and the latest runs: state, commit, why, when, how long, run id |
| `kayra app logs <server> <app> [run]` | A run's log, the newest unless named (`gc` or `renovate` for the jobs' runs); errors and warnings marked on a terminal |
| `kayra app deploy <server> <app> [ref]` | Build and deploy a branch, tag or commit; the app's ref by default |
| `kayra app rollback <server> <app> [sha]` | Without a commit: every release, the live one marked, each with its age. With one (the 7 characters the list shows are enough): deploy it again |
| `kayra job <server> gc` | The registry GC now (nightly at 03:00 otherwise) |
| `kayra job <server> renovate [--no-prs]` | Renovate now; `--no-prs` logs what would change |

A run started while one runs for the same app waits for it; of several waiting,
only the newest runs. The runs and their logs are also at
`https://deploy.<domain>/`, behind the staff login.

## In an app's repository

| Command | What it does |
|---|---|
| `kayra app check [dir]` | What the platform checks at deploy: `app.yml`, images, the compose policy. Needs no fleet; see [the app contract](../../concepts/app-contract/#check-before-you-push) |

## Fleet-wide

| Command | What it does |
|---|---|
| `kayra status` | Every server and whether a machine exists for it |
| `kayra validate [server]` | The fleet beyond its schemas: secrets (unknown keys must be helpers `vars.yml` uses), each app's `app.yml` against the fleet's values, `compose_stacks` against `stacks/`, `edge_routes` |
| `kayra doctor` | Check that this machine can run every command on every server: tools, vault passwords, app repositories, home servers' SSH |
| `kayra certs <domain> [subdomain…]` | mkcert certificates for local development |
| `kayra version`, `kayra --version` | The version of the kayra that runs: in a fleet, the one it pins. Needs no fleet |

## When to run what

| Changed | Run |
|---|---|
| Host settings (`defaults.yml`, `vars.yml`, `secrets.yml`) | `kayra setup <server>` |
| App values (`apps/<app>.yml`, `apps/<app>.secrets.yml`), or an app's secrets, config or subdomains in `app.yml` | `kayra apps <server>` |
| App code or compose files | nothing — push; the next deploy takes them from the commit |
| A new kayra version in `package.json` | `npm ci`, then `kayra deploy <server>` per server — a new version may change the app role, which `setup` alone does not run |
| Everything (a fresh server) | `kayra up <server>` |

Upgrading to 0.8.0 in particular needs `kayra deploy` (or `kayra apps` after `setup`): `setup` removes the Jenkins registration, and only `apps` writes the deployer's.
