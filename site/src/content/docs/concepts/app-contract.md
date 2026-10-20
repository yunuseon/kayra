---
title: The app contract
description: What an app provides to run on kayra, and what it may not do.
---

What an app has to provide to run on the platform, and what it may not do.
An app is **data**: a manifest, compose files and Dockerfiles. It contains no
pipeline, no deployment scripts and no server configuration — the platform
supplies all of that, the same way for every app.

## What happens when you push

1. A push to the app's branch (usually `main`) starts a **run** for that
   commit. Every artifact whose inputs changed since its last build is built
   from its Dockerfile and pushed to the platform registry. Unchanged
   artifacts are not rebuilt.
2. A green build deploys exactly that commit: the app's compose files are
   checked against the [policy](#compose-policy), started with
   `docker compose up --wait`, and the release is recorded.
3. The commit gets two statuses, `kayra/build` and `kayra/deploy`, each
   linking to the run's log at `https://deploy.<environment domain>/`.

Pushes that arrive while a run goes wait for it, and only the newest of them
runs. Any other branch, tag or commit can be deployed on demand
(`kayra app deploy`), and earlier releases restored (`kayra app rollback`).

A service you remove from your compose files is removed from the server by the
next deploy.

## An existing project

A project that already runs with Docker Compose, or from a single Dockerfile,
gets its contract written for it, once:

```bash
npx @yunuseon/kayra app init         # or: kayra app init [dir] [--name NAME]
```

It leaves the project's own files as they are and writes:

- `app.yml`: the project's compose file plus `kayra/compose.yml`; a route per
  service that publishes a port (the service's name as the host); and every
  variable the compose file needs without a default, and every key of its
  `env_file`s (never their values), as `secrets` when the name looks secret
  (`PASSWORD`, `TOKEN`, `KEY`, …) and `config` otherwise;
- `kayra/compose.yml`, an overlay that uses Compose's `!reset` and `!override`
  to drop what the platform does instead (`build`, `ports`, `env_file`,
  `container_name`), gives each built service its image variable and a
  `mem_limit` of 512m if it had none, and turns bind mounts of directories into
  named volumes, which start empty on the server;
- `kayra/<service>/docker/image.json` for each service the project builds.

Then it runs [the check](#check-before-you-push), and says what is left for a
person: a bind mount of a single file, a key the policy refuses
(`privileged`, `cap_add`, …), build `args`, a service without a healthcheck.
A project with only a Dockerfile becomes one service, `web`, on `www` at the
port it `EXPOSE`s. Review the files, commit them, and set the values with
`kayra app config set` and `kayra app secret import|generate`.

## Check before you push

In the app's repository, with Node 24, `git`, `jq`, `yq` and the Docker CLI
with Compose (no daemon needed):

```bash
npx @yunuseon/kayra app check        # or: kayra app check [dir]
```

It checks what the platform checks when it deploys: `app.yml` against its
schema, its compose files and routes, every `docker/image.json` (the
image in the app's namespace, a commit touching its inputs), and the compose
config they resolve to against the [policy](#compose-policy), with placeholder
values for images, config and secrets, and hosts under `example.test`. The
same scripts run on the server, so what passes here passes admission there.
Run it in the app's CI too; it needs no fleet and no server.

## Your own repository

An app usually lives in a repository of its own, with `app.yml` at its root.
The operator registers it once, with the repository's URL and the branch that
deploys (usually `main`). For that the operator needs:

- the platform's access token extended to the repository (Contents: read,
  Commit statuses: read and write), or registration and builds cannot clone it;
- a webhook on the repository (push events, JSON, the platform's secret — on
  GitLab its secret token — to `https://deploy.<environment domain>/hook/<app>`). Without it the platform
  still notices a push within the hour.

`kayra app hook <server> <app>` checks the first and sets up the second on
GitHub, GitLab, Forgejo or Gitea (`kayra app launch` runs it too). A server
may take no webhooks at all (`webhooks: false`); pushes then deploy when its
`deploy_poll` finds them.

Rollback only reaches releases built from the repository the app is in now: a
release from before a move to another repository cannot be restored.

## `app.yml`

At the root of the app (or of its directory, when an app shares a repo):

```yaml
name: shop                     # lower-case; also the compose project, the
                               # registry namespace and the runs' name
compose:                       # deployed together, in this order
  - deploy/compose.yml
routes:                        # how the app is reached; see Routes
  - {host: www, service: web, port: 3000}
  - {host: api, service: api, port: 3000}
secrets: [DATABASE_PASSWORD]   # values provided by the operator per environment
config: [FEATURE_FLAGS]        # same, but not secret
```

- Every name in `secrets` and `config` needs a value from the operator for each
  environment, or registering the app fails. Changing these lists, or adding
  a host to `routes`, needs the operator to re-register the app; compose
  files, code and the rest of `routes` do not. `kayra app values` lists what
  is still missing; `app config set`, `app secret import` and
  `app secret generate` fill it in ([CLI](../../reference/cli/#an-apps-values)).
- `secrets` reach the deploy as environment variables of the same name —
  reference them in compose as `${DATABASE_PASSWORD:?}`. `config` values and
  `DOMAIN` are available the same way.

## Routes

The platform routes your app; your compose files say nothing about it. Each
route sends `<host>.<environment domain>` to a service's port:

```yaml
routes:
  - {host: www, service: web, port: 3000}
  - {host: api, service: api, port: 3000}
  - host: api
    path: /signup                # a prefix: /signup and everything below it
    service: api
    port: 3000
    rate_limit: {average: 20, period: 10m, burst: 5}
  - {host: app, service: web, port: 3000, check: /healthz}
```

- `host` is a subdomain. Your app's hosts are its routes' hosts, and may not be
  the platform's own (`deploy`, `auth`, `traefik`).
- `service` is a service in your compose files, `port` the port it listens on
  inside its container. Nothing is published on the host.
- `path` is a prefix. A route with a path wins over its host's route without
  one, so the example's `/signup` gets its own rate limit and the rest of `api`
  none.
- `rate_limit` caps what one client address may send: `average` requests per
  `period` (`10s`, `10m`, `1h`), and `burst` at once beyond that.
- `check` is a path that answers 2xx or 3xx once the app is ready. After
  `docker compose up --wait` (your healthchecks), a deploy asks every route
  through Traefik for up to a minute: its `check`, or its own path, which must
  then answer below 500. A route that never does fails the run, with what it
  answered; the new release still runs.
- Every route serves HTTPS with a real certificate and the platform's security
  headers (HSTS, `nosniff`, `X-Frame-Options: SAMEORIGIN`, a Referrer-Policy).

Routes are read from the commit being deployed, like the compose files: a new
port or path ships with the code that needs it. A new host needs the operator
(`kayra apps`), and is refused until then.

The platform attaches each routed service to its network for Traefik and labels
it. Services that talk to each other share a network of **your own**, and
address each other by service name there.

## Artifacts: `docker/image.json` + a Dockerfile

Every directory that contains `docker/image.json` is an artifact, named after
that directory. Paths are relative to the app root, and **must stay inside it**
— the build sees the app's checkout and nothing next to it, so a `context` or
an input like `../..` breaks the build and the image tag.

```json
{
  "image": "shop/web",
  "dockerfile": "web/docker/Dockerfile",
  "context": ".",
  "inputs": ["web", "package.json", "pnpm-lock.yaml"]
}
```

- `image` must be in the app's namespace: `<name>/<anything>`.
- `inputs` decide the image tag: it is the last commit that touched any of
  them. List everything the build reads, or a change will not be rebuilt.
- **The Dockerfile is the whole build.** The build machine has no language
  toolchain: install dependencies, compile, run type checks and tests inside
  the Dockerfile, so that a failure fails the image.
- In compose, refer to an artifact's image through the variable the platform
  sets for it: `web` → `${WEB_IMAGE}` (upper-cased, `-` becomes `_`).

## Compose policy

Before every deploy, the resolved compose config (all files, variables and
defaults applied) is checked. It follows the spirit of Kubernetes' Pod
Security *restricted* profile: an app may not reach the host, other apps, or
the platform.

It is an allow-list. A service may use only these keys; anything else is
refused by name:

`image`, `command`, `entrypoint`, `environment`, `labels`, `networks`
(with `aliases` only), `volumes`, `tmpfs`, `healthcheck`, `depends_on`,
`restart`, `user`, `working_dir`, `init`, `read_only`, `expose`,
`stop_grace_period`, `stop_signal`, `mem_limit`, `mem_reservation`, `cpus`,
`deploy` (with `resources` only, no devices).

**Every service needs a memory limit** (`mem_limit`, or
`deploy.resources.limits.memory`). All apps share one server; one without a
limit can starve the others.

Within those keys:

| Not allowed | Why | Instead |
|---|---|---|
| bind mounts, file-backed `secrets`/`configs`, volume `driver_opts` | host filesystem | named volumes |
| `env_file`, `label_file` | read on the platform's machine, not yours | `environment`, with values from your `config`/`secrets` |
| images in another app's registry namespace | | your `<name>/…` images, or public ones |
| networks other than your own, external volumes, volumes of another project | other apps' data | your own networks and volumes |
| `traefik.*` labels | routing is the platform's | [`routes`](#routes) in `app.yml` |
| `platform-*` networks | the platform attaches routed services itself | your own networks |
| a route to a service your compose files lack, or to a host not registered | | a service you have; `kayra apps` for a new host |

Bring your own login. The platform's login is for its own pages: your users
belong to your app, which therefore runs the same with or without the
platform.

Give every long-running service a `healthcheck`: the deploy waits until all
of them report healthy, and fails if one does not within three minutes.

## Databases and migrations

Run migrations when the service that owns the database starts. Keep them
additive (add columns and tables; drop them only one release after the code
stopped using them) — a rollback runs the previous release's code against the
current schema.
