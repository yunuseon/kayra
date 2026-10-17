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

## Your own repository

An app usually lives in a repository of its own, with `app.yml` at its root.
The operator registers it once, with the repository's URL and the branch that
deploys (usually `main`). For that the operator needs:

- the platform's access token extended to the repository (Contents: read,
  Commit statuses: read and write), or registration and builds cannot clone it;
- a webhook on the repository (push events, JSON, the platform's secret, to
  `https://deploy.<environment domain>/hook/<app>`). Without it the platform
  still notices a push within the hour.

Rollback only reaches releases built from the repository the app is in now: a
release from before a move to another repository cannot be restored.

## `app.yml`

At the root of the app (or of its directory, when an app shares a repo):

```yaml
name: shop                     # lower-case; also the compose project, the
                               # registry namespace and the runs' name
compose:                       # deployed together, in this order
  - deploy/compose.yml
subdomains: [www, api]         # served as <subdomain>.<environment domain>
secrets: [DATABASE_PASSWORD]   # values provided by the operator per environment
config: [FEATURE_FLAGS]        # same, but not secret
```

- `subdomains` may not use the platform's own (`deploy`, `auth`, `traefik`).
- Every name in `secrets` and `config` needs a value from the operator for each
  environment, or registering the app fails. Changing these lists, or
  `subdomains`, needs the operator to re-register the app; compose files and
  code do not.
- `secrets` reach the deploy as environment variables of the same name —
  reference them in compose as `${DATABASE_PASSWORD:?}`. `config` values and
  `DOMAIN` are available the same way.

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
| networks other than your own and `platform-public`, external volumes, volumes of another project | other apps' data | your own networks and volumes |
| aliases on `platform-public` without the `<name>-` prefix | would capture another app's traffic | aliases on your own network |
| `platform-public` without `external: true` | your project would own the platform's network, and its `down` remove it | `name: platform-public`, `external: true` |
| Traefik rules without `Host()`, `HostRegexp`, hosts outside your subdomains | other apps' hostnames | `Host(\`www.${DOMAIN}\`)` |
| Traefik router/service/middleware names without the `<name>-` prefix | names are shared by all apps; a clash takes both down | `traefik.http.routers.shop-web…` |
| `traefik.tcp.*`, `traefik.udp.*`, `@internal` services | platform internals | HTTP routers to your services |

`platform-public` is shared by every app on the server. Put only what Traefik
routes to on it, and keep databases on a network of your own. **Do not address
your own services by service name across it**: `api` there is any app's to
claim. Use a network of your own, or the container name (`<name>-api-1`).

Routing, in short: join the `platform-public` network, and label the service

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.shop-web.rule=Host(`www.${DOMAIN}`)
  - traefik.http.routers.shop-web.entrypoints=websecure
  - traefik.http.routers.shop-web.tls.certresolver=le
  - traefik.http.services.shop-web.loadbalancer.server.port=3000
```

Every router gets the platform's security headers (HSTS, `nosniff`,
`X-Frame-Options: SAMEORIGIN`, a Referrer-Policy) without asking.

Bring your own login. The platform's login (`authelia@file`) is for its own
pages and is refused on an app's router: your users belong to your app, which
therefore runs the same with or without the platform.

Give every long-running service a `healthcheck`: the deploy waits until all
of them report healthy, and fails if one does not within three minutes.

## Databases and migrations

Run migrations when the service that owns the database starts. Keep them
additive (add columns and tables; drop them only one release after the code
stopped using them) — a rollback runs the previous release's code against the
current schema.
