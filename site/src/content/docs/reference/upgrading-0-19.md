---
title: Upgrade to 0.19.0
description: Apps declare routes in app.yml instead of Traefik labels; how a fleet and its apps move over.
---

0.19.0 takes routing away from the apps. An app declares its `routes` in
`app.yml`, and the platform writes the Traefik labels and attaches the
platform network itself. The compose policy now refuses any `traefik.*` label
and any `platform-*` network in an app's compose files. See
[the app contract](../../concepts/app-contract/#routes).

## Each app

In `app.yml`, `subdomains` is gone. Name each route instead:

```yaml
# before
subdomains: [www, api]

# after
routes:
  - {host: www, service: web, port: 3000}
  - {host: api, service: api, port: 3000}
```

In the compose files:

- drop every `traefik.*` label: a router's host becomes the route's `host`, a
  `PathPrefix` or `Path` its `path`, the service's
  `loadbalancer.server.port` its `port`;
- drop the `platform-public` network, both from the services and from the
  top-level `networks`;
- a service that called another of the app's services across
  `platform-public` (often by container name, `shop-api-1`) joins a network of
  the app's own with it, and calls it by service name;
- a rate limit becomes the route's `rate_limit`. The platform's
  `trial-ratelimit@file` middleware is gone: it was one app's.

`kayra app check` in the app's repository says what is left.

## Each server

The order keeps every app serving throughout. A server keeps running the
containers it has, labels included, until each app's next deploy.

1. Bump the fleet's kayra to 0.19.0 and merge it.
2. `kayra setup <server>`, not `deploy`: the new builder and deployer, while
   the apps keep the registrations the old kayra wrote.
3. Each app merges its migration. Its push deploys under the new contract.
4. `kayra deploy <server>`: registers each app from its new `app.yml` and ends
   with `kayra verify`, which now probes each route.

`kayra apps` or `kayra deploy` stops at an app whose `app.yml` still says
`subdomains`. Until an app has migrated, a push of its old shape is refused by
admission and its running containers keep serving.

Two things to know:

- **Rollback stays on its side of the move.** A release from before an app's
  migration carries Traefik labels, so admission refuses it.
- **The rate limit gap.** `kayra setup` removes `trial-ratelimit@file` from
  the server. A router of an app that still names it stops, and its requests
  fall to the host's other routers without the limit, until the app's
  migration deploys with a `rate_limit` on that route.
