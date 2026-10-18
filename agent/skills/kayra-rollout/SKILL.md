---
name: kayra-rollout
description: Bring a kayra fleet's servers to a new kayra release - the version bump PR in each fleet (in a separate git worktree), its checks, the merge, then kayra deploy server by server in a safe order with kayra verify after each. Use this whenever a kayra release exists that the servers don't run yet, when the user says "roll it out", "bump the fleets", "deploy the new kayra", "update the servers", "Renovate opened a kayra bump", or after the kayra-release skill finishes.
---

# Rolling kayra out to the fleets

A fleet pins kayra in its `package.json`; its servers run what that pinned
kayra copies to them. Rolling out means: bump the pin in the fleet, merge,
then deploy each server, least important first, checking each before the
next.

## The rule that matters most: separate worktrees

The user works in the same checkouts in parallel: their own branch and
uncommitted changes. Make every change in a **separate git worktree off
`origin/main`**, with absolute paths, as one script under
`set -euo pipefail`, one command per line. Never let a step that writes run
after `;` behind a guard: `[ -z "$(git status --short)" ] && git switch -c x;
npm install …` ran the `npm install` in the user's tree. Record the user's
`git status --short` before and check it is unchanged at the end.

Deploying is different: `require-main.sh` refuses a real server unless **the
fleet's checkout** is a clean `main` equal to `origin/main`, with the pinned
kayra installed (not a link). If the user's checkout isn't (their branch,
their changes), don't switch it: tell them, and deploy when they say it is
on `main`.

## 1. Which fleets, which servers, which order

- The fleets are the repositories that pin `@yunuseon/kayra`. Their own
  CLAUDE.md or README names them, how their PRs work (GitHub `gh`, Forgejo
  `tea`), and the rollout order. Read that and follow it.
- Without an order given: multipass and test servers first, then home
  servers, then real ones (hetzner), the least important first. Platform
  servers get `kayra deploy`; edge and NAS servers get `kayra setup`.
- Read the release notes between the fleet's version and the new one. A
  breaking release says exactly what a fleet must change (settings renamed or
  removed, new secrets): those changes go into the same bump PR.

## 2. The bump PR, per fleet

In a worktree of the fleet:

```bash
npm install --prefix "$W" --silent -D -E @yunuseon/kayra@<version>
# …the fleet changes the release asks for (vault edits: decrypt in memory, never print a value)
cd "$W" && kayra validate
```

Run the fleet's checks the way its CI does, against **tracked files only**
(untracked local folders such as a lab server must not count): copy
`git ls-files` plus `node_modules` into a temp context and
`docker build -f <kayra checkout>/ci/checks/Dockerfile --build-context fleet=<context> --build-arg CHECKS="--fleet /fleet" <kayra checkout>`,
with the kayra checkout at the released tag.

Commit (the message names the release and anything the fleet changed),
push, open the PR the fleet's way, wait for its checks (GitHub:
`gh pr checks --watch`; Forgejo: `tea api /repos/<owner>/<repo>/commits/<sha>/status`
until `success`), then merge. Merges ask the operator (kayra's guard); that
is expected. In auto mode the guard refuses them, and every non-multipass
deploy below, instead: stop, give the operator the exact command, continue
once they ran it. Remove the worktree and the local branch.

## 3. Deploy, server by server

From the fleet's own checkout once it is on the merged `main` (`git pull`,
then `npm ci`, so `node_modules` is the released version):

- `kayra deploy <platform server>`, **not** `kayra setup`: a new version may
  change the app role, which only `apps` runs. `deploy` ends with
  `kayra verify` and fails if the server is broken. Read every `✗`.
- `kayra setup <edge or nas server>`. A NAS's SSH may be on only on demand:
  if it refuses the connection, ask the user to switch it on. Don't retry in
  a loop.
- One server at a time, in order. Stop at the first failure, find the cause,
  and fix it in kayra if it is kayra's, before touching the next server.

Things that have bitten before:
- **A new platform hostname needs DNS before the deploy.** Traefik asks
  Let's Encrypt once; a name without DNS keeps Traefik's default certificate
  until Traefik restarts. `verify` reports it as `certificate by TRAEFIK
  DEFAULT CERT`.
- **A Docker upgrade by the docker role restarts every container.** That's
  normal; check the server's public routes afterwards.
- **Changed platform config on an upgraded server:** `verify` catches what
  did not reload (a 403 from Authelia meant rules it had never loaded).

## 4. Report

Per server: the version it runs now, the deploy's recap (nothing failed?),
the `kayra verify` result, and anything left for the user (a DNS apply, a
switch in a vendor UI, a manual cleanup). Then whether the user's checkouts
are as they left them.
