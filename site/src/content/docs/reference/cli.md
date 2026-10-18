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

## In an app's repository

| Command | What it does |
|---|---|
| `kayra app check [dir]` | What the platform checks at deploy: `app.yml`, images, the compose policy. Needs no fleet; see [the app contract](../../concepts/app-contract/#check-before-you-push) |

## Fleet-wide

| Command | What it does |
|---|---|
| `kayra status [--offline] [--json]` | Every server: where it is, whether its SSH answers and, on a platform server, its login. See below |
| `kayra validate [server] [--json]` | The fleet beyond its schemas: secrets (unknown keys must be helpers `vars.yml` uses), each app's `app.yml` against the fleet's values, `compose_stacks` against `stacks/`, `edge_routes`. Exits 1 on a problem |
| `kayra doctor` | Check that this machine can run every command on every server: tools, vault passwords, app repositories, home servers' SSH |
| `kayra certs <domain> [subdomain…]` | mkcert certificates for local development |
| `kayra version`, `kayra --version` | The version of the kayra that runs: in a fleet, the one it pins. Needs no fleet |

## The fleet at a glance

```
SERVER  KIND      TARGET   DOMAIN                    ADDRESS          SSH        HTTPS      APPS
alaz    platform  home     alaz.home.example.com     192.168.1.250    open 35ms  200 101ms  wiki
edge    edge      hetzner  example.com               203.0.113.7      open 34ms
nas     nas       home     example.com               192.168.1.141    off
```

- **ADDRESS** is the server's `inventory.ini` where there is one (hand-written
  for a home server, written by `provision` otherwise), else OpenTofu's
  `server_ip` output if its state holds a machine. Otherwise `not provisioned`
  (an empty state), `no machine` (the state holds something else, such as a
  storage box) or `state unreadable`, with OpenTofu's reason under the table.
- **SSH** is a TCP connection to the inventory's port, given up after two
  seconds: `open` and how long it took, `off` when nothing listens (an SSH
  switched on only on demand, as on a NAS), `no answer`, `unreachable`,
  `unknown host`.
- **HTTPS**, on platform servers, asks `https://auth.<domain>/api/health`
  (Authelia's health) the way a browser would, through DNS: its status and time,
  or `untrusted cert`, `wrong cert`, `cert expired`, `refused`, `no answer`.
  The system's trust store counts, so a multipass server's mkcert certificate
  is trusted where mkcert installed its root.
- Every server is asked at once. On a terminal the table is there at once and
  its cells fill in as the answers arrive, and the domains are links (iTerm2,
  WezTerm, Ghostty, VS Code); piped, it is printed once, plain. `--offline`
  asks no server: only the fleet and OpenTofu's state, and no columns for the
  probes.

`kayra validate` lists each server's checks under it: `✓` holds, `✗` a
problem, with what to do about it on the line below, `·` not checked (a vault
without its password file, an app not cloned yet). The last line sums it up:

```
✗ edge  edge on hetzner
    ✗ secrets.yml: 'gti_token' is no secret of an edge server, and vars.yml does not use it
      → did you mean 'git_token'?
    ✓ edge_routes: 6 routes, each with subdomains and a host:port upstream

✗ 3 servers · 1 problem · 1 not checked
```

### `--json`

Both print one JSON document on stdout and nothing on stderr; `validate` still
exits 1 on a problem. kayra adds fields to these shapes; it renames or removes
one only in a release that says so.

```json
{
  "servers": [
    {
      "name": "alaz",
      "kind": "platform",
      "target": "home",
      "domain": "alaz.home.example.com",
      "apps": ["wiki"],
      "machine": { "state": "found", "address": "192.168.1.250", "from": "inventory", "reason": null },
      "ssh": { "port": 22, "state": "open", "ms": 35, "error": null },
      "https": { "url": "https://auth.alaz.home.example.com/api/health", "state": "answered", "status": 200, "ms": 101, "error": null }
    }
  ]
}
```

| Field | Values |
|---|---|
| `machine.state` | `found` (`address`, or `null` if OpenTofu has no `server_ip`; `from`: `inventory` or `opentofu`), `not-provisioned`, `no-machine`, `unreadable` (`reason`) |
| `ssh.state`, `https.state` | `open` (SSH) or `answered` (HTTPS, with `status`), both with `ms`; `refused`, `no-answer`, `unreachable`, `unknown-host`, `bad-certificate` and `failed` (with Node's code in `error`); `skipped` when there is nothing to ask (no address, `--offline`) |
| `https` | `null` on a server that is not a platform |

```json
{
  "result": "problem",
  "problems": 1,
  "unchecked": 1,
  "servers": [
    {
      "name": "edge",
      "kind": "edge",
      "target": "hetzner",
      "result": "problem",
      "findings": [
        { "result": "problem", "text": "secrets.yml: 'gti_token' is no secret of an edge server, and vars.yml does not use it", "hint": "did you mean 'git_token'?" },
        { "result": "passed", "text": "edge_routes: 6 routes, each with subdomains and a host:port upstream", "hint": null }
      ]
    }
  ]
}
```

`result` is `problem`, `unchecked` or `passed`: a finding's own, a server's and
the whole run's the worst of what is under it. `hint` is what to do, or `null`.

## When to run what

| Changed | Run |
|---|---|
| Host settings (`defaults.yml`, `vars.yml`, `secrets.yml`) | `kayra setup <server>` |
| App values (`apps/<app>.yml`, `apps/<app>.secrets.yml`), or an app's secrets, config or subdomains in `app.yml` | `kayra apps <server>` |
| App code or compose files | nothing — push; the next deploy takes them from the commit |
| A new kayra version in `package.json` | `npm ci`, then `kayra deploy <server>` per server — a new version may change the app role, which `setup` alone does not run |
| Everything (a fresh server) | `kayra up <server>` |

Upgrading to 0.8.0 in particular needs `kayra deploy` (or `kayra apps` after `setup`): `setup` removes the Jenkins registration, and only `apps` writes the deployer's.
