---
title: CLI
description: Every kayra command.
---

Run from anywhere inside a fleet. Server and app names complete in the shell.
Every command takes `--dry-run`: it prints the plan — each command, guard and
confirmation, with its environment — and runs nothing.

## Per server

| Command | What it does |
|---|---|
| `kayra up <server>` | Provision, set up everything, point `/etc/hosts` at it (multipass) |
| `kayra provision <server>` | Create or update the machine (target home: build the image to import) |
| `kayra deploy <server>` | Host setup and every app, no provisioning |
| `kayra setup <server>` | The host layer only: the playbook for the server's kind |
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

| Command | What it does |
|---|---|
| `kayra app runs <server> <app>` | The app's latest runs: id, result, commit, why |
| `kayra app logs <server> <app> [run]` | A run's log, the newest unless named (`gc` or `renovate` for the jobs' runs) |
| `kayra app deploy <server> <app> [ref]` | Build and deploy a branch, tag or commit; the app's ref by default |
| `kayra app rollback <server> <app> [sha]` | Without a commit: what runs now and the earlier releases. With one (12 characters are enough): deploy it again |
| `kayra job <server> gc` | The registry GC now (nightly at 03:00 otherwise) |
| `kayra job <server> renovate [--no-prs]` | Renovate now; `--no-prs` logs what would change |

A run started while one runs for the same app waits for it; of several waiting,
only the newest runs. The runs and their logs are also at
`https://deploy.<domain>/`, behind the staff login.

## Fleet-wide

| Command | What it does |
|---|---|
| `kayra status` | Every server and whether a machine exists for it |
| `kayra validate [server]` | The fleet beyond its schemas: secrets (unknown keys must be helpers `vars.yml` uses), each app's `app.yml` against the fleet's values, `compose_stacks` against `stacks/`, `edge_routes` |
| `kayra doctor` | Check that this machine can run every command on every server: tools, vault passwords, app repositories, home servers' SSH |
| `kayra certs <domain> [subdomain…]` | mkcert certificates for local development |

## When to run what

| Changed | Run |
|---|---|
| Host settings (`defaults.yml`, `vars.yml`, `secrets.yml`) | `kayra setup <server>` |
| App values (`apps/<app>.yml`, `apps/<app>.secrets.yml`), or an app's secrets, config or subdomains in `app.yml` | `kayra apps <server>` |
| App code or compose files | nothing — push; the next deploy takes them from the commit |
| A new kayra version in `package.json` | `npm ci`, then `kayra deploy <server>` per server — a new version may change the app role, which `setup` alone does not run |
| Everything (a fresh server) | `kayra up <server>` |

Upgrading to 0.8.0 in particular needs `kayra deploy` (or `kayra apps` after `setup`): `setup` removes the Jenkins registration, and only `apps` writes the deployer's.
