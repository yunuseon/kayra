---
title: MCP
description: kayra mcp, every kayra operation as a tool for an agent such as Claude Code.
---

`kayra mcp` is an [MCP](https://modelcontextprotocol.io) server on stdin and
stdout. It offers every kayra operation as a tool, so an agent such as Claude
Code runs the fleet the way the command line does: the same catalog, plans,
guards and interpreter. Nothing listens on a port. The agent starts the server
for its session and stops it when the session ends.

## Setup

In the fleet, a `.mcp.json` beside `servers/`:

```json
{
  "mcpServers": {
    "kayra": { "command": "kayra", "args": ["mcp"] }
  }
}
```

The `kayra` on `PATH` hands over to the version the fleet pins, as it does for
every command. Claude Code asks once before it starts a project's MCP server.

## The tools

One tool per operation, named after it with `.` spelled `_`: `deploy`,
`setup`, `verify`, `app_deploy`, `app_runs`, `backup_test`, `ssh_exec`, … Each
tool's description is the operation's summary, and its input is the
operation's input. `server` lists the fleet's servers, so an agent can name no
other.

- **Plans** (`up`, `deploy`, `setup`, `plan`, `verify`, `apps`, `down`, …) take
  `dryRun` (list the steps, run nothing) and `verbose` (Ansible's own output).
  A run sends a progress notification as each step begins. The result is the
  run as text: each step, its output, how it went, and the footer. A failed or
  stopped run is a tool error. The deployer's commands (`app_deploy`,
  `app_rollback`, `job`) and `ssh_exec` answer with their output alone.
- **Queries** (`validate`, `app_runs`, `app_releases`, `app_log`, `version`)
  and `status` answer at once. Where the answer is an object, it is structured
  content in the same shape as the [API](../api/) and `--json`.
- **`ssh`**, the interactive shell, is not a tool: an agent cannot hold a
  terminal. `ssh_exec` runs a command.

A change runs on one server at a time: a second change to a server whose run
has not ended is refused. Cancelling a call stops its step, as Ctrl-C does.

## What asks, and who

| | |
|---|---|
| A tool that changes nothing (`status`, `validate`, `verify`, `plan`, `doctor`, `version`, `app_check`, `app_runs`, `app_log`, `app_releases`) | Runs |
| `dryRun: true` | Runs; changes nothing |
| A change to a multipass server | Runs |
| A change to any other server, or with no server (`certs`) | As Claude Code's permission mode decides |
| `down`, `app_purge` | Claude Code asks every time, in every mode, with no "always allow" |
| `down` on a Hetzner server | Also asks the operator, in a dialog, to type the server's name. The agent never sees what was typed |

The plans keep their own guards: a Hetzner or home server changes only from a
clean `main` with the pinned kayra, exactly as from the command line.

## Passwords

No password passes through MCP. A step that needs a vault password or sudo's
stops, and the result says which and how to give it another way:

- `vault_password_file` in the server's `server.yml` (kayra reads the file;
  nothing is asked);
- sudo's cached first (`sudo -v`) for the few steps that need it (`hosts`);
- or the command, run in a terminal.
