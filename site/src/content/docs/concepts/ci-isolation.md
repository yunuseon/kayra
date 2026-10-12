---
title: CI isolation
description: Why app code cannot reach the host or the platform.
---

Apps are built from branches anyone with push access controls. The platform
treats that code as untrusted: it may run, but only where it cannot reach the
host or the platform.

## Who runs what

```
jenkins-agent        no docker socket, no docker CLI, no language toolchain
   │                 checks out the app at the requested ref
   │ buildctl over TCP
   ▼
buildkitd            rootless, under AppArmor profile buildkit-rootless;
   │                 runs the app's Dockerfiles — the only app code CI executes
   ▼
registry             on platform-internal only; no router
   ▲
jenkins-controller   holds the docker socket; runs only admission (compose
                     policy) and `docker compose up`, with pipeline code from
                     the platform library, never from the app
```

- **No pipeline comes from an app.** Every app's `build` and `deploy` jobs are
  inline scripts rendered by the platform, calling the platform library, which
  Jenkins loads — trusted, with no version override — from `PLATFORM_REF`. The
  ref being built is data: checked out, never the source of the steps Jenkins
  runs.
- **The agent cannot reach the host.** No socket, no Docker CLI; its label is
  `buildkit linux`, so nothing asking for `docker` lands there.
- **Builds are containers, not the host.** Rootless BuildKit puts each build in
  an unprivileged user namespace.
- **What reaches the controller is admitted first.** The app's compose files
  pass `compose-policy.sh` (an allow-list, memory limits required, no host
  access, no foreign images/networks/volumes, `env_file` refused) before
  `docker compose up`.

## Why buildkitd has its own AppArmor profile

Ubuntu 23.10+ refuses unprivileged user namespaces to *unconfined* processes
(`kernel.apparmor_restrict_unprivileged_userns=1`), so rootlesskit cannot start
under the settings BuildKit's documentation suggests. Its docs propose turning
the sysctl off; that would restore the namespaces for every process on the box.

Instead the `docker` role installs `/etc/apparmor.d/buildkit-rootless`, a named,
permissive profile that explicitly carries `userns`, and compose applies it with
`security_opt: apparmor=buildkit-rootless`. The host keeps the restriction:

```bash
cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns   # 1
sudo aa-status | grep buildkit                                # buildkitd confined
```

`moby/buildkit` does not read `BUILDKITD_FLAGS`; its flags are the container's
command, or it listens on a unix socket the agent cannot reach.

## Two registry hostnames, one registry

`resolve-images.sh` pushes to `registry:5000` (reachable from containers on
`platform-internal`) and emits refs as `localhost:5000` (reachable from the host
daemon, which `docker compose` pulls with). Same storage, different hostname.
The existence check is a plain `GET /v2/<image>/manifests/<tag>`.

## What is still reachable

- **A build can write any app's images.** The registry is unauthenticated on
  `platform-internal`, and BuildKit `RUN` steps reach it: a hostile Dockerfile
  can overwrite another app's tag. Per-app registry credentials (Zot, a planned change) close it before the first untrusted tenant.
- **Apps can reach each other.** See [authentication](../authentication/),
  "Known residual risk".
- **Whoever can push an app's deployed branch deploys it.** That is the
  contract — the compose policy is the gate, not a review.
