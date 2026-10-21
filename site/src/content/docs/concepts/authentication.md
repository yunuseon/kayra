---
title: Authentication
description: Staff login with Authelia; apps bring their own.
---

Authelia guards the platform's own pages — the runs pages and Traefik's dashboard —
for the operators. Apps bring their own login: their users belong to the app
and its customer, never to this file (see the app contract).

## How it fits together

```
browser ──▶ Traefik ──forwardAuth──▶ Authelia     (is this operator signed in?)
                │
                ▼
      runs pages / Traefik dashboard
```

Traefik asks Authelia about every request to a router that carries
`authelia@file`, and Authelia either redirects to its portal at
`auth.<domain>` or lets the request through. Its access rules name only
platform hosts; the compose policy refuses `authelia@file` on an app's router.

| What | Protection |
|---|---|
| Traefik dashboard (`traefik.<domain>`) | Authelia (group `admin`) |
| Runs pages (`deploy.<domain>`) | Authelia (group `admin`); read-only; `/hook/` is exempt (HMAC-checked) |
| Registry | Not routed at all — reachable only on `platform-internal` |
| Everything an app routes | The app's own login, if it has one |

Policy per server: `authelia_policy` in `servers/<server>/vars.yml` — `two_factor`
by default, `one_factor` where there is no SMTP yet (passkey enrolment needs
mail, or the operator relaying the code below).

## Adding an operator

1. Generate an argon2id hash of a temporary password:

   ```bash
   docker run --rm authelia/authelia:4.39.28 authelia crypto hash generate argon2 \
     --variant argon2id --iterations 3 --memory 32768 --parallelism 2
   ```

2. Add them to `authelia_users` in `servers/<server>/secrets.yml` (`sops edit`), with
   `groups: ['admin']`, through a PR (hetzner servers only change from `main`).

3. Apply: `kayra setup <server>`.

4. With `two_factor`: they sign in with the temporary password, go to
   **Settings → Security → Add → WebAuthn** and enrol a passkey. Without SMTP
   the one-time code is written to a file instead of mailed:

   ```bash
   kayra ssh <server>
   docker exec platform-authelia-1 tail -30 /data/notification.txt
   ```

## Recovery

**Authelia is down.** Apps and deploys are unaffected; the runs pages and
Traefik's dashboard are not reachable. `docker logs platform-authelia-1 --tail 50` usually names a
config or secret error. Automation does not depend on it: `kayra app …` talks
to the deployer over SSH, and webhooks skip it.

**Lost passkeys.** Credentials live in the `authelia-data` volume. If it is lost,
everyone re-enrols with their bootstrap password. Back it up.

## Why these are not SSO

- **The registry.** The Docker CLI cannot follow a browser OIDC redirect; a
  forwardAuth on it would break every push. It has no router instead.

## Why apps do not use it

Anything **inside** `platform-public` — every app's containers — can reach
another app's service directly, by container name, and send any header it
likes: Traefik strips forged `Remote-*` headers only on the way in from
outside. An app trusting identity headers would be only as safe as the least
trustworthy app on the same server. An app that resolves its own sessions has
no such dependency, and keeps working without the platform.
