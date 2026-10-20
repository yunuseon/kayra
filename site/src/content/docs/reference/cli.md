---
title: CLI
description: Every kayra command.
---

Run from anywhere inside a fleet. Server and app names complete in the shell
(`eval "$(kayra completion zsh)"`; also `bash`, `fish`, `pwsh`, `nu`).
Every command takes `--dry-run`: it prints the plan — each command, guard and
confirmation, with its environment — and runs nothing. On a terminal each step
is numbered under its title, paths named by their root (`<kayra>`, `<fleet>`,
`~`); piped, it prints one plain, copyable line per step.

The same commands, with each step live in the browser: `kayra serve`, the
[web interface](../web-ui/). Programs on the same machine can use the
[local API](../api/) with `kayra serve --api`.

Every command also takes `-v`/`--verbose`: its playbooks print Ansible's own
output (`ANSIBLE_STDOUT_CALLBACK=default`, with `-v`) instead of kayra's
summary of it, for a failure the summary does not explain. It is part of the
plan, so `--dry-run -v` shows it.

`kayra --help` lists the commands in the sections below, with examples;
`kayra <command> --help` (or `kayra help <command>`) says what one does, its
arguments — the fleet's servers among them — and examples. A misspelt server,
job or command is refused with the nearest one: `Did you mean "shop-test"?`.

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

## Local clients

`kayra serve [--ui] [--api] [--port N] [--no-open]` starts a listener on
127.0.0.1. The browser is enabled by default; `--api` alone enables only program
access. Use both flags to serve both clients.

```bash
kayra serve                           # browser; opens the launch URL
kayra serve --ui --api                 # browser and local program API
kayra serve --api --no-open --port 0   # program API on a free port
kayra serve --port 7700 --no-open       # fixed port, print the browser URL
```

The default is an available port (`--port 0`). With `--api`,
read the actual API URL and bearer token from the fleet's `.cache/serve.json`
(mode 0600); kayra removes it on shutdown. The browser uses a launch cookie.
See the [API reference](../api/) for authentication, operation requests, run
events and terminal sessions.

Commands share the same plans and guards across clients. Vault and sudo
questions use hidden terminal input on the CLI, password fields in the browser,
and secret question events in the API. Interactive `kayra ssh` inherits the
terminal; the browser/API use a terminal session.

From 0.17.0, replace `kayra ui` with `kayra serve`; there is no alias. See the
[0.17.0 upgrade notes](../upgrading-0-17/).

`kayra mcp` serves every operation as a tool to an agent such as Claude Code,
over stdin and stdout, started by the agent from the fleet's `.mcp.json`. It
asks for no password. See the [MCP reference](../mcp/).

## Per server

| Command | What it does |
|---|---|
| `kayra up <server>` | Provision, set up everything, point `/etc/hosts` at it (multipass) |
| `kayra provision <server>` | Create or update the machine (target home: build the image to import) |
| `kayra deploy <server>` | Host setup and every app, no provisioning |
| `kayra setup <server>` | The host layer only: the playbook for the server's kind |
| `kayra verify <server>` | Whether a platform server works as its users see it: logins, real certificates, a refused unsigned webhook, every app hostname, the registrations, containers, last runs and open alerts. `deploy` and `up` run it at the end. A server set up by another kayra than the one that runs is noted (`!`), not failed: it still works, and every server runs the last release until a rollout reaches it |
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
| `kayra app deploy <server> <app> [ref]` | Build and deploy a branch, tag or commit; the app's ref by default. Follows the run to its end: see below |
| `kayra app rollback <server> <app> [sha]` | Without a commit: every release, the live one marked, each with its age. With one (the 7 characters the list shows are enough): deploy it again, followed like a deploy |
| `kayra job <server> gc` | The registry GC now (nightly at 03:00 otherwise) |
| `kayra job <server> renovate [--no-prs]` | Renovate now; `--no-prs` logs what would change |

A run started while one runs for the same app waits for it (`queued`); of
several waiting, only the newest runs, and the others end `superseded`. The
runs and their logs are also at `https://deploy.<domain>/`, behind the staff
login.

`app deploy` and `app rollback` print the run's log as it grows and end with
what came of it, exiting 0 only when it deployed and every route answered
([readiness](../../concepts/app-contract/#routes)):

```
$ kayra app deploy shop-prod shop
…
12:00:41 ready  https://www.shop.example.com/  200
12:00:41 Deployed a1b2c3d4…
✓ shop a1b2c3d deployed (run 20261018T120000Z-abcdef)
  https://www.shop.example.com/
```

A failed run ends with its reason (`✗ shop a1b2c3d: refused by the compose
policy (run …)`); `app runs` shows the newest one's under its table, and
`app runs --json` gives every run's `error`, `urls` and readiness `checks`.

## Launching an app

```
kayra app launch <server> <app> [--repo URL] [--ref REF] [--path PATH] [--dir DIR]
```

From an app's repository to a URL that answers, in one command that can be
run again until it gets there:

1. **Register and check.** Adds the app to `servers/<server>/server.yml` if it
   is not there (`--repo` is needed then; comments are kept), and checks that
   every value its `app.yml` declares is set. If any is missing, it stops and
   prints the command that sets each one.
2. **Apply.** `kayra apps <server>`, the new entry included. On a hetzner or
   home server the main-only guard stops here until the `server.yml` change is
   merged: commit it, merge it to `main`, run the launch again.
3. **Deploy.** `kayra app deploy`, followed to its end, ready routes and URLs
   included.

`--dir` points at the app's checkout, for its `app.yml` before the fleet has
cloned the app. A step already done is done again harmlessly: registering
finds the entry, `apps` changes nothing, the deploy reuses its images. A new
app still needs its webhook (or the hourly poll) for later pushes, and its
hosts in DNS.

## An app's values

What an app's `app.yml` declares in `config` and `secrets`, set in the fleet's
`apps/<app>.yml` and `apps/<app>.secrets.yml` (vaulted where the server's
secrets are). These edit files on this machine only: review the change, then
`kayra apps <server>` applies it, from `main` on a hetzner or home server.

| Command | What it does |
|---|---|
| `kayra app values <server> <app> [--dir DIR] [--json]` | Each declared key: `set`, `missing`, or `locked` (a vault that cannot be opened without a prompt). Never a value |
| `kayra app config set <server> <app> KEY VALUE [--dir DIR]` | A declared configuration value, in plaintext |
| `kayra app secret import <server> <app> KEY FILE [--dir DIR]` | A declared secret from a file (one trailing newline dropped), so it is in no argument, log or run record |
| `kayra app secret generate <server> <app> KEY [--dir DIR]` | 32 random bytes, hex, only if the key has no value yet: a retry keeps it |

`app.yml` is read from the app's clone in `.cache/`, or from `--dir`, an app
checkout not yet cloned there. A key `app.yml` does not declare is refused.

## In an app's repository

| Command | What it does |
|---|---|
| `kayra app init [dir] [--name NAME]` | Make an existing compose or Dockerfile project deployable: writes `app.yml`, an overlay and its image manifests, leaving its own files alone, then checks them. Needs no fleet; see [an existing project](../../concepts/app-contract/#an-existing-project) |
| `kayra app check [dir]` | What the platform checks at deploy: `app.yml`, images, the compose policy. Needs no fleet; see [the app contract](../../concepts/app-contract/#check-before-you-push) |

## Fleet-wide

| Command | What it does |
|---|---|
| `kayra status [--offline] [--json]` | Every server: where it is, whether its SSH answers, which kayra set it up and, on a platform server, its login. See below |
| `kayra validate [server] [--json]` | The fleet beyond its schemas: secrets (unknown keys must be helpers `vars.yml` uses), each app's `app.yml` against the fleet's values, `compose_stacks` against `stacks/`, `edge_routes`. Exits 1 on a problem |
| `kayra doctor` | Check that this machine can run every command on every server: tools, vault passwords, app repositories, home servers' SSH |
| `kayra certs <domain> [subdomain…]` | mkcert certificates for local development |
| `kayra version`, `kayra --version` | The version of the kayra that runs: in a fleet, the one it pins. Needs no fleet |

## The fleet at a glance

```
SERVER  KIND      TARGET   DOMAIN                    ADDRESS          SSH        HTTPS      KAYRA          APPS
alaz    platform  home     alaz.home.example.com     192.168.1.250    open 35ms  200 101ms  1.2.3          wiki
edge    edge      hetzner  example.com               203.0.113.7      open 34ms             1.2.2 → 1.2.3
nas     nas       home     example.com               192.168.1.141    off                   –
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
- **KAYRA** is the kayra that last set the server up, as its setup recorded
  it (`/opt/kayra/version`; on a NAS `<nas_root>/.kayra/version`), read over
  SSH once SSH is open, as the inventory says and never asking (batch mode, no
  host key to confirm). Where it is not the kayra that runs, the fleet's pin,
  the pin follows it: `1.2.2 → 1.2.3` is what `kayra setup` (`kayra deploy` on
  a platform server) would make it. `unrecorded → 1.2.3` is a server set up by
  a kayra from before servers recorded it; `unreadable`, with SSH's reason
  under the table; `–` where nothing was asked (SSH not open, no
  `inventory.ini` to log in with). An SSH login costs a handshake per server,
  all at once, after the TCP probe.
- Every server is asked at once. On a terminal the table is there at once and
  its cells fill in as the answers arrive, and the domains are links (iTerm2,
  WezTerm, Ghostty, VS Code); piped, it is printed once, plain. `--offline`
  asks no server: only the fleet and OpenTofu's state, and no columns for the
  probes or the version.

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
      "https": { "url": "https://auth.alaz.home.example.com/api/health", "state": "answered", "status": 200, "ms": 101, "error": null },
      "kayra": { "pin": "1.2.3", "state": "recorded", "version": "1.2.3", "error": null }
    }
  ]
}
```

| Field | Values |
|---|---|
| `machine.state` | `found` (`address`, or `null` if OpenTofu has no `server_ip`; `from`: `inventory` or `opentofu`), `not-provisioned`, `no-machine`, `unreadable` (`reason`) |
| `ssh.state`, `https.state` | `open` (SSH) or `answered` (HTTPS, with `status`), both with `ms`; `refused`, `no-answer`, `unreachable`, `unknown-host`, `bad-certificate` and `failed` (with Node's code in `error`); `skipped` when there is nothing to ask (no address, `--offline`) |
| `https` | `null` on a server that is not a platform |
| `kayra` | `pin`: the kayra that runs, the one the fleet pins. `state`: `recorded` (`version`: the kayra that last set the server up), `unrecorded` (set up by a kayra from before servers recorded it), `unreadable` (`error`: SSH's reason, or what the file holds instead), `skipped` (SSH not open, no inventory, `--offline`) |

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
| App values (`apps/<app>.yml`, `apps/<app>.secrets.yml`), or an app's secrets, config or a new route host in `app.yml` | `kayra apps <server>` |
| App code or compose files | nothing — push; the next deploy takes them from the commit |
| A new kayra version in `package.json` | `npm ci`, then `kayra deploy <server>` per server — a new version may change the app role, which `setup` alone does not run |
| Everything (a fresh server) | `kayra up <server>` |
