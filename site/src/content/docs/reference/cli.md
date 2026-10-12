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
| `kayra apps <server>` | Make the server's apps match `server.yml`: register each, remove the rest (data kept) |
| `kayra hosts <server>` | Point the domain at a multipass VM in `/etc/hosts` (sudo) |
| `kayra ssh <server>` | SSH into the server |
| `kayra down <server>` | Destroy the machine (asks for the name on a Hetzner server) |
| `kayra adopt <server>` | Once, for a server not created by kayra: add the `deploy` user as root |
| `kayra backup test <server>` | Restore the latest backup to a scratch dir, check it, delete it — started on the server, followed over SSH |
| `kayra app purge <server> <app>` | Delete a removed app's volumes: its data, irreversibly |

Hetzner and home servers change only from a clean `main` equal to its remote:
`provision`, `adopt`, `setup`, `apps` and `app purge` refuse anything else.

## Fleet-wide

| Command | What it does |
|---|---|
| `kayra status` | Every server and whether a machine exists for it |
| `kayra doctor` | Check that this machine can run every command on every server: tools, vault passwords, app repositories, home servers' SSH |
| `kayra certs <domain> [subdomain…]` | mkcert certificates for local development |

## When to run what

| Changed | Run |
|---|---|
| Host settings (`defaults.yml`, `vars.yml`, `secrets.yml`) | `kayra setup <server>` |
| App values (`apps/<app>.yml`, `apps/<app>.secrets.yml`), or an app's secrets, config or subdomains in `app.yml` | `kayra apps <server>` |
| App code or compose files | nothing — push; the next deploy takes them from the commit |
| A new kayra version in `package.json` | `npm ci`, then `kayra setup <server>` per server |
| Everything (a fresh server) | `kayra up <server>` |
