---
title: Upgrade to 0.17.0
description: What changes for a fleet upgrading its local kayra clients from 0.16.1 to 0.17.0.
---

0.17.0 adds the local program API and brings the browser up to the CLI's
operation catalog. One package still supplies the core and all three clients.

## Required changes

Replace `kayra ui` with `kayra serve` in scripts, shortcuts and documentation.
There is no `ui` alias. The browser remains the default:

```bash
kayra serve                   # the previous kayra ui workflow
kayra serve --ui --api         # browser and program API together
kayra serve --api --no-open    # program API only
```

The fleet format, vault password file settings and other CLI commands keep
their existing shapes. Fleet repositories need the exact dependency bump and
its lockfile; no server configuration migration is required for this release.

## Program clients

Use the [local API reference](../api/). Program access is opt-in with `--api`.
Read the URL and bearer token from the fleet's private `.cache/serve.json` for
each launch. Routes use `/api`, without a separate API version: the fleet's
pinned kayra version defines the contract.

The API dispatches operations from the same catalog as the CLI and browser.
Plans can be previewed, queries return JSON, and run events stream as SSE or
NDJSON. Changes to real servers require their name in `confirm`, and the
plans retain their own guards and typed confirmations.

## Questions and SSH

When a server has no vault password file, kayra asks for its password once per
run, before a step needs it. The CLI hides typing, the browser shows a password
field, and API clients answer a secret `ask` event. Existing configured vault
password files continue to work. Sudo questions for local hosts changes use
the same interaction path.

The browser supports interactive SSH, including terminal input and output.
Leaving the terminal page keeps the session open; **Close session** ends it.
CLI SSH continues to use the operator's terminal.

## Fleet dependency bump

After 0.17.0 is published, update the fleet in a branch/worktree:

```bash
npm install --save-dev --save-exact @yunuseon/kayra@0.17.0
kayra validate
```

Commit `package.json` and `package-lock.json`, run the fleet's checks, and merge
its bump PR. Use the new CLI from the updated fleet checkout after `npm ci`.
This release changes the operator's local clients and helpers; adopting it
requires no server deploy. Server deployments remain separate operations.
