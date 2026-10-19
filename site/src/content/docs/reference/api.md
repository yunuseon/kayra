---
title: Local API
description: The local kayra API, its authentication, operations, runs and terminal sessions.
---

<!-- Generated from the OpenAPI contract by npm run contract. Edit cli/scripts/api-reference.ts. -->

The API runs on the operator's machine and uses the same operation catalog,
plans and guards as the CLI and browser. Start it from a fleet:

```bash
kayra serve --api --no-open         # programs only
kayra serve --ui --api              # browser and programs together
```

Routes live under `/api`, without a separate API version. The fleet's pinned
kayra version defines the contract; upgrading kayra replaces the API and bundled
UI together. `GET /api/openapi.json` supplies the full OpenAPI 3.1 document,
including request and response schemas. `GET /api/operations` supplies operation
names, summaries, scopes, effects, kinds and input JSON Schemas.

## Discovery and authentication

With `--api`, kayra writes `<fleet>/.cache/serve.json` with `url` (including
`/api`), `token` and `pid`, readable only by its owner (mode 0600). It removes
the file on shutdown. Read it afresh after restarting kayra: the port and token
belong to that launch. A second API listener for the same fleet is refused
while the discovery file's process is alive.

Programs send `Authorization: Bearer <token>`. The listener binds to
127.0.0.1; every request must use its exact host and port (127.0.0.1 or localhost).
The browser exchanges the launch URL's token for a per-port HttpOnly,
SameSite=Strict cookie. Cookie-authenticated writes require an Origin matching
the request's host and port. Bearer-authenticated writes require no Origin.
There is no CORS. Bearer access and discovery are enabled only with `--api`;
the UI uses the same API with its cookie.

This Node 24 example runs from the fleet root and reads only the version:

```js
import { readFile } from "node:fs/promises";

const { url, token } = JSON.parse(await readFile(".cache/serve.json", "utf8"));
const response = await fetch(url + "/operations/version", {
  method: "POST",
  headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
  body: JSON.stringify({ input: {} }),
});
if (!response.ok) throw new Error(await response.text());
console.log(await response.json());
```

## Invoking an operation

Send JSON to `POST /api/operations/<name>`:

```json
{
  "input": { "server": "shop-test" },
  "options": { "verbose": true, "dryRun": false }
}
```

`input` defaults to an empty object. The operation's schema checks its fields;
unknown fields are refused. The core also checks server/app names and whether
the chosen server supports the operation. Relative repository paths start at
the fleet root.

Plans return `202 {"run":"<id>"}`; terminal sessions return
`201 {"session":"<id>"}`. Queries return JSON directly with status 200.
Status streams answers as they arrive. The schemas and status tables below
come from the OpenAPI document.

### Run options

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `verbose` | `boolean` | no | `false` | — |
| `dryRun` | `boolean` | no | `false` | — |
| `columns` | `integer` | no | `120` | Minimum: 1. Maximum: 1000. |
| `rows` | `integer` | no | `32` | Minimum: 1. Maximum: 1000. |


For a plan or session, append `/preview` to its operation path to inspect the
steps without running them. `dryRun: true` also returns the preview, with status
200, instead of starting it. Verbose mode changes the same Ansible steps as the
CLI's `--verbose`. Terminal dimensions are set when the session starts.

### Confirmations and questions

Before changing a server whose target is not Multipass, supply its exact name
as `confirm` beside `input` and `options`:

```json
{
  "input": { "server": "shop-prod" },
  "confirm": "shop-prod"
}
```

The server checks this even for bearer callers. The plans retain their own
guards: Hetzner/home changes require the fleet's clean main branch and pinned
kayra package; destruction can ask for another typed confirmation. Only one
run or session may be live per server.

Follow a run's events. An `ask` event carries `prompt`, `secret` and, for a
confirmation, `expect`. Answer through
`POST /api/runs/<id>/answers` with `{"text":"..."}`. Answers are not recorded;
a secret belongs in a password field and should be cleared after submission.
Vault passwords are requested once per server per run when no password file is
configured. Sudo passwords reach the local hosts helper through stdin.

### Events and cancellation

`GET /api/runs/<id>/events` replays recorded events, then follows the run until
it ends. SSE is the default: JSON appears in `data:` frames, followed by an
`event: end` frame. Send `Accept: application/x-ndjson` for one JSON event per
line. Status and session output also accept NDJSON. Clients should read the
stream incrementally and stop when it ends; a reconnect replays from the start.

| Event | Fields |
| --- | --- |
| `plan` | `invocation`, `steps` |
| `started` | `index` |
| `done` | `index`, `failed`, `stopped`, `why`, `ms` |
| `ended` | `failures`, `stop`, `ms`, `footer` |
| `output` | `stream`, `chunk` |
| `said` | `stream`, `text` |
| `ask` | `prompt`, `secret`, `expect` |
| `answered` | — |

`POST /api/runs/<id>/cancel` cancels a run, including a pending question. It
sends SIGINT to the child process group, then SIGTERM after ten seconds if
needed. `DELETE /api/sessions/<id>` closes a terminal session the same way.
Stopping `kayra serve` cancels its work, waits for children, closes the listener
and removes discovery. Runs are recorded under `.cache/ui/runs/*.jsonl`.

Session output carries the same run events. Forward each output `chunk` to a
terminal emulator and send its input with
`POST /api/sessions/<id>/input` and `{"text":"..."}`. Send input requests in
order. Input requests are not stored separately; terminal output, including
anything echoed by the shell, is part of the run record. Leaving a browser
page or closing an event stream keeps the session running.

### Errors

Errors have a plain-text body. Invalid inputs/plans return 400, missing launch
authentication returns 401, host/origin/confirmation refusals return 403, missing
resources return 404, and a server with live work returns 409. An upstream query
can return 502; unexpected server failures return 500. Answer/input endpoints
return 404 when nothing is waiting. A successful answer, cancellation, input or
session-close request returns 204 with no body.

## Operations

### `up`

Provision, set up everything, point /etc/hosts at it.

`POST /api/operations/up`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `server` | `string` | yes | — | A server of the fleet (servers/&lt;name&gt;/) Minimum length: 1. |

Preview: `POST /api/operations/up/preview`. Returns a JSON plan with status 200.

| Status | Response | Content type |
| --- | --- | --- |
| `200` | Dry run | `application/json` |
| `202` | Started | `application/json` |
| `400` | Invalid input | — |
| `403` | Real server not confirmed | — |
| `409` | Server busy | — |

### `provision`

Create or update the machine (target home: build the image to import).

`POST /api/operations/provision`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `server` | `string` | yes | — | A server of the fleet (servers/&lt;name&gt;/) Minimum length: 1. |

Preview: `POST /api/operations/provision/preview`. Returns a JSON plan with status 200.

| Status | Response | Content type |
| --- | --- | --- |
| `200` | Dry run | `application/json` |
| `202` | Started | `application/json` |
| `400` | Invalid input | — |
| `403` | Real server not confirmed | — |
| `409` | Server busy | — |

### `deploy`

Host setup and every app, no provisioning.

`POST /api/operations/deploy`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `server` | `string` | yes | — | A server of the fleet (servers/&lt;name&gt;/) Minimum length: 1. |

Preview: `POST /api/operations/deploy/preview`. Returns a JSON plan with status 200.

| Status | Response | Content type |
| --- | --- | --- |
| `200` | Dry run | `application/json` |
| `202` | Started | `application/json` |
| `400` | Invalid input | — |
| `403` | Real server not confirmed | — |
| `409` | Server busy | — |

### `setup`

The host layer only: the playbook for the server's kind.

`POST /api/operations/setup`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `server` | `string` | yes | — | A server of the fleet (servers/&lt;name&gt;/) Minimum length: 1. |

Preview: `POST /api/operations/setup/preview`. Returns a JSON plan with status 200.

| Status | Response | Content type |
| --- | --- | --- |
| `200` | Dry run | `application/json` |
| `202` | Started | `application/json` |
| `400` | Invalid input | — |
| `403` | Real server not confirmed | — |
| `409` | Server busy | — |

### `plan`

What provision and setup would change, changing nothing (OpenTofu plan, Ansible check mode).

`POST /api/operations/plan`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `server` | `string` | yes | — | A server of the fleet (servers/&lt;name&gt;/) Minimum length: 1. |

Preview: `POST /api/operations/plan/preview`. Returns a JSON plan with status 200.

| Status | Response | Content type |
| --- | --- | --- |
| `200` | Dry run | `application/json` |
| `202` | Started | `application/json` |
| `400` | Invalid input | — |
| `403` | Real server not confirmed | — |
| `409` | Server busy | — |

### `verify`

Whether a platform server works as its users see it: logins, certificates, webhooks, apps, runs, alerts.

`POST /api/operations/verify`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `server` | `string` | yes | — | A server of the fleet (servers/&lt;name&gt;/) Minimum length: 1. |

Preview: `POST /api/operations/verify/preview`. Returns a JSON plan with status 200.

| Status | Response | Content type |
| --- | --- | --- |
| `200` | Dry run | `application/json` |
| `202` | Started | `application/json` |
| `400` | Invalid input | — |
| `403` | Real server not confirmed | — |
| `409` | Server busy | — |

### `apps`

Make the server's apps match server.yml: register each, remove the rest (data kept).

`POST /api/operations/apps`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `server` | `string` | yes | — | A server of the fleet (servers/&lt;name&gt;/) Minimum length: 1. |

Preview: `POST /api/operations/apps/preview`. Returns a JSON plan with status 200.

| Status | Response | Content type |
| --- | --- | --- |
| `200` | Dry run | `application/json` |
| `202` | Started | `application/json` |
| `400` | Invalid input | — |
| `403` | Real server not confirmed | — |
| `409` | Server busy | — |

### `hosts`

Point the domain at a multipass VM in /etc/hosts (sudo).

`POST /api/operations/hosts`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `server` | `string` | yes | — | A server of the fleet (servers/&lt;name&gt;/) Minimum length: 1. |

Preview: `POST /api/operations/hosts/preview`. Returns a JSON plan with status 200.

| Status | Response | Content type |
| --- | --- | --- |
| `200` | Dry run | `application/json` |
| `202` | Started | `application/json` |
| `400` | Invalid input | — |
| `403` | Real server not confirmed | — |
| `409` | Server busy | — |

### `ssh`

Open an interactive SSH session.

`POST /api/operations/ssh`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `server` | `string` | yes | — | A server of the fleet (servers/&lt;name&gt;/) Minimum length: 1. |

Preview: `POST /api/operations/ssh/preview`. Returns a JSON plan with status 200.

| Status | Response | Content type |
| --- | --- | --- |
| `200` | Dry run | `application/json` |
| `201` | Started | `application/json` |
| `400` | Invalid input | — |
| `403` | Real server not confirmed | — |
| `409` | Server busy | — |

### `ssh.exec`

Run a command over SSH.

`POST /api/operations/ssh.exec`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `server` | `string` | yes | — | A server of the fleet (servers/&lt;name&gt;/) Minimum length: 1. |
| `command` | `array of string` | yes | — | The remote command and arguments Minimum items: 1. |

Preview: `POST /api/operations/ssh.exec/preview`. Returns a JSON plan with status 200.

| Status | Response | Content type |
| --- | --- | --- |
| `200` | Dry run | `application/json` |
| `202` | Started | `application/json` |
| `400` | Invalid input | — |
| `403` | Real server not confirmed | — |
| `409` | Server busy | — |

### `down`

Destroy the machine.

`POST /api/operations/down`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `server` | `string` | yes | — | A server of the fleet (servers/&lt;name&gt;/) Minimum length: 1. |

Preview: `POST /api/operations/down/preview`. Returns a JSON plan with status 200.

| Status | Response | Content type |
| --- | --- | --- |
| `200` | Dry run | `application/json` |
| `202` | Started | `application/json` |
| `400` | Invalid input | — |
| `403` | Real server not confirmed | — |
| `409` | Server busy | — |

### `adopt`

Once, for a server we did not create: add the deploy user as root.

`POST /api/operations/adopt`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `server` | `string` | yes | — | A server of the fleet (servers/&lt;name&gt;/) Minimum length: 1. |

Preview: `POST /api/operations/adopt/preview`. Returns a JSON plan with status 200.

| Status | Response | Content type |
| --- | --- | --- |
| `200` | Dry run | `application/json` |
| `202` | Started | `application/json` |
| `400` | Invalid input | — |
| `403` | Real server not confirmed | — |
| `409` | Server busy | — |

### `backup.test`

Restore the latest backup to a scratch dir, check it, delete it.

`POST /api/operations/backup.test`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `server` | `string` | yes | — | A server of the fleet (servers/&lt;name&gt;/) Minimum length: 1. |

Preview: `POST /api/operations/backup.test/preview`. Returns a JSON plan with status 200.

| Status | Response | Content type |
| --- | --- | --- |
| `200` | Dry run | `application/json` |
| `202` | Started | `application/json` |
| `400` | Invalid input | — |
| `403` | Real server not confirmed | — |
| `409` | Server busy | — |

### `app.check`

What the platform checks at deploy (app.yml, images, compose policy), in an app's repository. No fleet needed.

`POST /api/operations/app.check`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `dir` | `string` | no | `"."` | The app's repository Minimum length: 1. |

Preview: `POST /api/operations/app.check/preview`. Returns a JSON plan with status 200.

| Status | Response | Content type |
| --- | --- | --- |
| `200` | Dry run | `application/json` |
| `202` | Started | `application/json` |
| `400` | Invalid input | — |
| `403` | Real server not confirmed | — |
| `409` | Server busy | — |

### `app.purge`

Delete a removed app's volumes: its data, irreversibly.

`POST /api/operations/app.purge`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `server` | `string` | yes | — | A server of the fleet (servers/&lt;name&gt;/) Minimum length: 1. |
| `app` | `string` | yes | — | An app name, including a removed app whose records or data remain Minimum length: 1. |

Preview: `POST /api/operations/app.purge/preview`. Returns a JSON plan with status 200.

| Status | Response | Content type |
| --- | --- | --- |
| `200` | Dry run | `application/json` |
| `202` | Started | `application/json` |
| `400` | Invalid input | — |
| `403` | Real server not confirmed | — |
| `409` | Server busy | — |

### `app.runs`

What runs now, and the app's latest runs: state, commit, why, when, how long.

`POST /api/operations/app.runs`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `server` | `string` | yes | — | A server of the fleet (servers/&lt;name&gt;/) Minimum length: 1. |
| `app` | `string` | yes | — | An app name, including a removed app whose records or data remain Minimum length: 1. |

| Status | Response | Content type |
| --- | --- | --- |
| `200` | What runs now, and the app's latest runs: state, commit, why, when, how long. | `application/json` |

### `app.log`

A run's log, the newest unless named; its errors and warnings marked.

`POST /api/operations/app.log`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `server` | `string` | yes | — | A server of the fleet (servers/&lt;name&gt;/) Minimum length: 1. |
| `app` | `string` | yes | — | An app name, including a removed app whose records or data remain Minimum length: 1. |
| `run` | `string` | no | — | A run's id; the newest by default Minimum length: 1. |

| Status | Response | Content type |
| --- | --- | --- |
| `200` | A run's log, the newest unless named; its errors and warnings marked. | `application/json` |

### `app.deploy`

Build and deploy a branch, tag or commit (default: the app's ref).

`POST /api/operations/app.deploy`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `server` | `string` | yes | — | A server of the fleet (servers/&lt;name&gt;/) Minimum length: 1. |
| `app` | `string` | yes | — | An app name, including a removed app whose records or data remain Minimum length: 1. |
| `ref` | `string` | no | — | A branch, tag or commit; the app's ref by default Minimum length: 1. |

Preview: `POST /api/operations/app.deploy/preview`. Returns a JSON plan with status 200.

| Status | Response | Content type |
| --- | --- | --- |
| `200` | Dry run | `application/json` |
| `202` | Started | `application/json` |
| `400` | Invalid input | — |
| `403` | Real server not confirmed | — |
| `409` | Server busy | — |

### `app.releases`

The app's releases: what runs now, and the earlier ones to roll back to.

`POST /api/operations/app.releases`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `server` | `string` | yes | — | A server of the fleet (servers/&lt;name&gt;/) Minimum length: 1. |
| `app` | `string` | yes | — | An app name, including a removed app whose records or data remain Minimum length: 1. |

| Status | Response | Content type |
| --- | --- | --- |
| `200` | The app's releases: what runs now, and the earlier ones to roll back to. | `application/json` |

### `app.rollback`

Deploy an earlier release again.

`POST /api/operations/app.rollback`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `server` | `string` | yes | — | A server of the fleet (servers/&lt;name&gt;/) Minimum length: 1. |
| `app` | `string` | yes | — | An app name, including a removed app whose records or data remain Minimum length: 1. |
| `sha` | `string` | yes | — | An earlier release's commit Pattern: `^[0-9a-f]{7,40}$`. |

Preview: `POST /api/operations/app.rollback/preview`. Returns a JSON plan with status 200.

| Status | Response | Content type |
| --- | --- | --- |
| `200` | Dry run | `application/json` |
| `202` | Started | `application/json` |
| `400` | Invalid input | — |
| `403` | Real server not confirmed | — |
| `409` | Server busy | — |

### `job`

Run a platform job now: the registry GC or Renovate.

`POST /api/operations/job`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `server` | `string` | yes | — | A server of the fleet (servers/&lt;name&gt;/) Minimum length: 1. |
| `job` | `"gc" or "renovate"` | yes | — | — |
| `noPrs` | `boolean` | no | `false` | Renovate: log what would change, open no PRs |

Preview: `POST /api/operations/job/preview`. Returns a JSON plan with status 200.

| Status | Response | Content type |
| --- | --- | --- |
| `200` | Dry run | `application/json` |
| `202` | Started | `application/json` |
| `400` | Invalid input | — |
| `403` | Real server not confirmed | — |
| `409` | Server busy | — |

### `status`

Every server: where it is, whether SSH and its login answer.

`POST /api/operations/status`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `offline` | `boolean` | no | `false` | Only what the fleet and OpenTofu's state say: reach no server |

| Status | Response | Content type |
| --- | --- | --- |
| `200` | Every server: where it is, whether SSH and its login answer. | `text/event-stream` |

### `validate`

Check the fleet beyond its schemas: secrets, apps against their contract, stacks, routes.

`POST /api/operations/validate`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `server` | `string` | no | — | A server of the fleet (servers/&lt;name&gt;/) Minimum length: 1. |

| Status | Response | Content type |
| --- | --- | --- |
| `200` | Check the fleet beyond its schemas: secrets, apps against their contract, stacks, routes. | `application/json` |

### `doctor`

Check that this Mac can run every command on every server.

`POST /api/operations/doctor`

No input fields.

Preview: `POST /api/operations/doctor/preview`. Returns a JSON plan with status 200.

| Status | Response | Content type |
| --- | --- | --- |
| `200` | Dry run | `application/json` |
| `202` | Started | `application/json` |
| `400` | Invalid input | — |
| `403` | Real server not confirmed | — |
| `409` | Server busy | — |

### `certs`

mkcert certs for a domain and its subdomains (local dev, multipass).

`POST /api/operations/certs`

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `domain` | `string` | yes | — | Minimum length: 1. |
| `subdomains` | `array of string` | no | `[]` | — |

Preview: `POST /api/operations/certs/preview`. Returns a JSON plan with status 200.

| Status | Response | Content type |
| --- | --- | --- |
| `200` | Dry run | `application/json` |
| `202` | Started | `application/json` |
| `400` | Invalid input | — |
| `403` | Real server not confirmed | — |
| `409` | Server busy | — |

### `version`

Which kayra this is.

`POST /api/operations/version`

No input fields.

| Status | Response | Content type |
| --- | --- | --- |
| `200` | Which kayra this is. | `application/json` |

## Resources

### `GET /api/operations`




| Status | Response | Content type |
| --- | --- | --- |
| `200` | The operation catalog | `application/json` |

### `GET /api/openapi.json`




| Status | Response | Content type |
| --- | --- | --- |
| `200` | This OpenAPI document | `application/json` |

### `GET /api/fleet`




| Status | Response | Content type |
| --- | --- | --- |
| `200` | The fleet | `application/json` |

### `GET /api/directories`

Browse local directories for app.check

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `path` | query | `string` | no |

| Status | Response | Content type |
| --- | --- | --- |
| `200` | Directories only, relative paths resolved from the fleet | `application/json` |
| `400` | Directory cannot be read | — |

### `GET /api/runs`




| Status | Response | Content type |
| --- | --- | --- |
| `200` | Runs from this fleet | `application/json` |

### `GET /api/runs/{id}`



| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | `string` | yes |

| Status | Response | Content type |
| --- | --- | --- |
| `200` | A recorded run | `application/json` |
| `404` | No run | — |

### `GET /api/runs/{id}/events`



| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | `string` | yes |

| Status | Response | Content type |
| --- | --- | --- |
| `200` | Events replayed from the start, then followed until the run ends | `text/event-stream`, `application/x-ndjson` |

### `POST /api/runs/{id}/answers`

Answer the pending question; answers are never recorded

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | `string` | yes |

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `text` | `string` | yes | — | — |

| Status | Response | Content type |
| --- | --- | --- |
| `204` | Accepted | no body |
| `404` | No active resource | — |

### `POST /api/runs/{id}/cancel`

Cancel a run

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | `string` | yes |

| Status | Response | Content type |
| --- | --- | --- |
| `204` | Accepted | no body |
| `404` | No active resource | — |

### `GET /api/sessions/{id}/output`



| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | `string` | yes |

| Status | Response | Content type |
| --- | --- | --- |
| `200` | Session events | `text/event-stream` |

### `POST /api/sessions/{id}/input`

Send terminal input; input is never recorded

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | `string` | yes |

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `text` | `string` | yes | — | — |

| Status | Response | Content type |
| --- | --- | --- |
| `204` | Accepted | no body |
| `404` | No active resource | — |

### `DELETE /api/sessions/{id}`

Close the session

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | `string` | yes |

| Status | Response | Content type |
| --- | --- | --- |
| `204` | Accepted | no body |
| `404` | No active resource | — |

