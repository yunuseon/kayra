# kayra — AI assistant guide

You are working in **kayra**: a self-hosted app platform (Traefik + Authelia + Jenkins + Registry + BuildKit, deployed to Hetzner, home machines or Multipass VMs via Ansible/OpenTofu) and the CLI that runs it. kayra is the **engine**; a **fleet** — a repository holding `servers/`, one folder per server — is its configuration, and apps live in their own repositories as plain data. kayra knows no fleet and no app by name.

Read this file before making infrastructure, CI/CD, or compose changes — there are non-obvious load-bearing rules below that have already cost real time.

Open work lives in GitHub issues.

## Where this repo lives: GitHub

`github.com/yunuseon/kayra` — public, MIT-licensed (`LICENSE`). Issues, pull requests, checks and releases all happen there.

- **A change:** branch off `main`, push, open a PR (`gh pr create`). The checks (`.github/workflows/checks.yml`: `run.sh --platform`) run on the PR. Commits carry a DCO sign-off (`git commit -s`, see `CONTRIBUTING.md`).
- **Releases** are tags `vMAJOR.MINOR.PATCH`, cut from `main` after bumping `version` in `package.json`: `release.yml` publishes `@yunuseon/kayra` to npmjs.org through trusted publishing (no token; provenance included). `0.x` while the fleet contract may still change in any release; a fleet pins the version it runs.
- **Dependencies** arrive as Renovate PRs (`renovate.json`).

---

## Repo layout (load-bearing)

The engine only: it knows no fleet and no app by name. A fleet is the directory holding `servers/` (`FLEET_ROOT`); kayra finds it from the working directory and never derives it from its own location (`KAYRA_ROOT`).

| Path | Concern |
|---|---|
| `ansible/`, `compose/`, `terraform/`, `cloud-init.yml.tpl`, `hosts.conf` | The platform: Traefik, Authelia, Jenkins, Registry, BuildKit, Ansible roles, OpenTofu modules, cloud-init |
| `ci/jenkins-lib/` | The pipeline library every app runs (`appBuild`, `appDeploy`) + its scripts (`resources/platform/`) |
| `ci/` | Platform jobs (registry GC, rollback), the compose-policy tests, the checks (`ci/checks/`) |
| `cli/` | kayra, the CLI: every server's lifecycle — the only layer that touches both host setup and apps |
| `site/` | The docs site (Starlight on GitHub Pages): pages in `src/content/docs/`, the architecture model in `model/*.c4` (LikeC4) |

Shell scripts live in four places, by **where they run**:

| Path | Runs on |
|---|---|
| `scripts/local/` | the operator's machine, called by kayra (`require-main.sh`, `certs.sh`, `setup-hosts.sh`, …); a script reading the fleet's files takes `FLEET_ROOT` from kayra |
| `scripts/server/` | the server: installed to `/opt/platform/bin` by the platform role (`jenkins-api`, `jenkins-app-apply`, `app-remove`, …) |
| `ci/` | the controller, as platform jobs (`registry-gc.sh`, the `*.Jenkinsfile`s, `checks/`) |
| `ci/jenkins-lib/resources/platform/` | the build agent or controller, shipped inside the pipeline library (`resolve-images.sh`, `compose-policy.sh`, …) |

App-specific code does **not** belong here: no app a fleet registers may be named apart from comments (checked by the fleet's checks, `run.sh --fleet`).

---

## CLI (`kayra`)

`cli/` is kayra: TypeScript run by Node 24's type stripping, [Optique](https://optique.dev) for arguments. The repo root is the npm package `@yunuseon/kayra` (the CLI plus every engine file it uses); a checkout runs `cli/src` as is, the published package `cli/dist`, compiled at `npm pack`/`publish` (Node strips no types inside `node_modules`). `bin/kayra.js` picks one. Once per machine:

```bash
npm ci                  # and after a lockfile change
npm link                # `kayra` on PATH (again after switching Node)
kayra doctor                           # tools, vault passwords, home servers' SSH
```

**Common flows** (from anywhere in a fleet; server names complete in the shell):

```bash
kayra up shop-test           # provision + host setup + apps + /etc/hosts
kayra deploy shop-test       # host setup + apps, no re-provision
kayra setup shop-test        # host layer only (the playbook for its kind)
kayra apps shop-test         # register every app (config, secrets, jobs)
kayra ssh shop-test          # SSH into it
kayra down shop-test         # destroy
kayra status                 # all servers + status
kayra setup shop-prod --dry-run   # any command: print the plan, run nothing
```

Also `provision`, `hosts`, `adopt`, `backup test`, `app purge`, `certs`. App repos are cloned locally (`.cache/apps`) with the operator's own git credentials (`gh auth setup-git`). App development happens in each app's own repository.

- **A fleet pins its kayra:** `@yunuseon/kayra` as an exact dev dependency in the fleet's `package.json`. Whatever `kayra` is on PATH hands over to the fleet's `node_modules/@yunuseon/kayra` (`bin/kayra.js`), so the version the fleet pins is the one that runs. To try a kayra checkout against a fleet: `npm link @yunuseon/kayra` in the fleet.
- **One version for the Mac and the servers:** kayra passes its version as `kayra_version`; the platform role's `platform_ref` defaults to `v<version>`, the tag Jenkins loads the pipeline library and platform jobs from. Releases: bump `version` in `package.json`, merge, tag `v<version>` (release.yml publishes to npmjs.org).
- **A command is pure:** `(engine, server) => Result<Plan>`, a readonly list of steps: `run` (with env, and `$(…)`-style queries resolved when it runs), a `check` (a guard stops the plan; doctor's report and go on), `confirm`, `note`. `interpret.ts` is the only code that runs anything.
- **Two roots:** the engine (`KAYRA_ROOT`, `kayra`) and the fleet (`FLEET_ROOT`, the directory holding `servers/`) are named apart everywhere, so the engine can live elsewhere (A2). kayra passes `FLEET_ROOT` to the local scripts; Ansible has `kayra_root` (above the playbooks) and `fleet_root` (above `server_dir`). Never derive one from the other.
- **Every server is validated whenever kayra loads the fleet** (`parseServer`): kind, target, domain, apps, inventory or `terraform/`, vaulting. A broken server.yml anywhere stops every command.
- **Golden tests:** `test/golden/record.sh <out>` runs `test/golden/cases` against a fixture fleet with ansible, tofu, ssh and the local scripts stubbed, recording argv, Ansible env, stdout and exit status; `cli-test` holds kayra to `expected/`. It was recorded from the justfiles kayra replaced, which proved the two equal. Re-record a case only for a change meant to alter it, and read the diff.
- **Brands for every meaningful string** (`src/brand.ts`, the only file where `as` is allowed; arguments are minted by its Optique value parsers); errors are `Result` values, not exceptions.
- Strictest tsconfig, `typescript-eslint` strict + `eslint-plugin-functional` (no `let`, no mutation). An inline `eslint-disable` says why. Dependencies are pinned exactly (`.npmrc`).
- The checks run `cli-typecheck`, `cli-lint`, `cli-test`. Locally: `npm run typecheck|lint|test` at the root.

---

## The fleet contract: one folder per server

The operating model is **one server per customer** (occasionally several apps on one server to save money), plus special-purpose servers. Everything about a server lives in its folder of the fleet; kayra holds only reusable code.

```
servers/shop-prod/
├── server.yml          topology only: kind, target, domain, apps
├── vars.yml            settings, plaintext (only what differs per server)
├── secrets.yml         secrets (vault on hetzner, plaintext test values on multipass)
├── apps/<app>.yml      the operator's config for each app, plaintext
├── apps/<app>.secrets.yml   …and its secrets (vault on hetzner and home)
├── terraform/          main.tf etc.; terraform.tfvars + state are gitignored
└── inventory.ini       generated by `kayra provision` (gitignored)
```

```yaml
# server.yml
kind: platform             # platform (Traefik, Authelia, Jenkins, apps) | edge | nas
target: hetzner            # hetzner | multipass | home — gates cert source + /etc/hosts
domain: shop.example.com
vault: true
apps:
  - {name: shop, repo: https://github.com/example/shop.git, ref: main, path: .}
```

- **Adding a customer** = copying a server folder, adjusting `server.yml`, `vars.yml`, `secrets.yml`, `apps/*` and `terraform/`.
- **Where a value goes** — by how much it varies, not by habit:
  - the same on every server (acme email, admin user, platform repo) → `servers/defaults.yml`, once
  - different per server, not secret → `vars.yml`, plaintext, so it can be read and diffed
  - secret → `secrets.yml`; kayra refuses a hetzner or home server whose `secrets.yml` is not vaulted, and any whose `vars.yml` is. The same split per app: `apps/<app>.yml` (config, never vaulted) and `apps/<app>.secrets.yml`
  - which repos a server's Renovate keeps up to date → `renovate_repositories` in its `vars.yml`
  - a value that never varies is not a setting: write it where it is used
- `kind` picks the playbook (`ansible/playbooks/<kind>.yml`); only `platform` servers run apps.
  `edge` (e.g. `servers/edge/`) is a WireGuard tunnel into a private network plus Caddy in front of it — roles `wireguard` + `edge-proxy`, routes and keys in its `vars.yml` — and the outside eye on that network's backups (`backup-check`: hourly, reads each repository's newest snapshot and restore-test result over read-only HTTPS, a GitHub issue when either goes stale or a test fails).
  `nas` (`servers/nas/`) is a box whose OS belongs to its vendor (UGOS): the play writes nothing outside `nas_root` (`/volume2`) and asserts so before any change — no packages, users or system config, which a firmware update would reset; everything runs as containers. `/volume1` (media, homes) is never written; the backup reads from it (`restic_backup.paths`, mounted read-only, asserted to exist so Docker never creates one). Role `compose-stacks`: the services, one `servers/nas/stacks/<name>/compose.yaml` each, every image pinned, only what differs from the image's defaults plus an explicit `container_name` (the proxy's Caddyfile addresses containers by it) — the stack folder (compose file plus any config it mounts as `./…`, e.g. Homepage's dashboard, read-only) and an `.env` to `/volume2/docker/stacks/<name>/`, data mounted from where it already lives. Private images: `compose_registry_logins` in `secrets.yml` (`{registry, username, password}`), logged in with a Docker config inside the stacks' directory, never the host's. Role `restic-backup`: nightly restic over SFTP to a Hetzner Storage Box (`servers/nas/terraform/`, its own daily snapshots), Postgres dumped first, pruned on Sundays; a restore test monthly by cron (a twelfth of the data read each time) and by hand with `kayra backup test nas`, its result uploaded next to the repository.
- `target: home` is a machine at home that nothing can create for us: no `terraform/`, a hand-written, committed `inventory.ini`, and otherwise treated like hetzner — vault required, changed only from `main`. A NAS is one; a VM on it another: for those, `kayra provision` builds the Ubuntu cloud image and a seed ISO from the same `cloud-init.yml.tpl` (plus a fixed address, `vm:` in `vars.yml`), imported into UGOS's VM app by hand.
- **Adopting a server we did not create** (it keeps its IP/type/price): `import {}` it into its `terraform/`, rebuild it from the Hetzner console/API, `kayra adopt <name>` (creates `deploy` as root, once), then `kayra deploy <name>`. `hcloud-server` ignores `user_data`/`ssh_keys`/`image` for exactly this — and so that a cloud-init edit never replaces a live server.
- **Testing platform changes before merging:** set `platform_ref: <branch>` in `servers/<test-server>/vars.yml` (Jenkins then loads the pipeline library and platform jobs from it) and `ref: <branch>` on the app entry. Only a test server ever tracks anything but `main`.
- **Hetzner servers only change from `main` as merged.** Every kayra command deploys the local checkout; `require-main.sh` makes `provision`, `adopt`, `setup`, `apps` and `app purge` refuse a hetzner or home server unless the checkout is a clean `main` equal to `origin/main` (other servers' folders may be dirty — that is where test pointers live). A vault edit for prod therefore goes through a PR before it is deployed. Never add a bypass: deploying a feature branch to prod once turned the platform's own checks off there.
- **An app in its own repo** needs, once: the platform's `git_token` and the Renovate token extended to the repo, a GitHub webhook to `https://jenkins.<domain>/github-webhook/` with the platform's secret, `kayra apps <server>`, and one manual `<app>/build` (the push trigger learns the repo from a build that checked it out). The app's local dev never needs the platform.

---

## Apps: the contract (read before touching any app or pipeline)

An app is **data**. It never contains a Jenkinsfile, Ansible or JCasC — that is what lets it move to its own repo and be handed to a customer without exposing the platform.
The customer-facing version of this section is the site's `concepts/app-contract.md` — keep the two in step.

```yaml
# app.yml, at the root of the app's repository
name: shop
compose: [deploy/compose.yml, deploy/compose.deploy.yml]
subdomains: [www, api]                        # <sub>.<domain>
secrets: [DATABASE_PASSWORD]
config: [FEATURE_FLAGS]
```

Plus, per artifact, `docker/image.json` — `{image: "<app>/<name>", dockerfile, context, inputs}`, all relative to the app root — and its Dockerfile. **The Dockerfile is the whole build**: checks such as typecheck run inside it, so the build agent needs no toolchain.

What the platform does with it:

| Step | Who | What |
|---|---|---|
| `kayra apps <server>` | platform `app` role | reads `app.yml` + `servers/<server>/apps/<app>.yml`; fails on missing values or a platform subdomain; writes `/opt/apps/<app>/.env` (config), `10-<app>.yaml` (folder `<app>/` with `build` + `deploy` jobs, credentials `<app>-<key>`), pipes secrets to `jenkins-app-apply` |
| `<app>/build` | library `appBuild` | on push to the app's ref: build each missing content-addressed image, then start `<app>/deploy` with that exact SHA |
| app dropped from `server.yml`, then `kayra apps <server>` | `bin/app-remove` (via `apps-prune.yml`) | containers down; fragment, secrets, `.env`, Jenkins folder + history, release records gone; **volumes kept** — `kayra app purge <server> <app>` deletes them, and only once the app is unregistered; the next registry GC collects its images |
| `<app>/deploy` | library `appDeploy` | check out REF; build missing images; on the controller, **admit** the compose files listed in `app.yml` at REF with `compose-policy.sh`, `docker compose up --wait`, record the release |

On the server:

```
/opt/platform/                       compose project "platform"
├── .env                             incl. COMPOSE_FILE: plain `docker compose` works here
├── jenkins-agent.env                agent secret, fetched from Jenkins every run
├── jenkins/casc/00-platform.yaml    platform JCasC: library, GC + rollback jobs
├── jenkins/casc/10-<app>.yaml       ← rendered per app by the app role
├── jenkins-secrets/<app>/<KEY>      ← written by bin/jenkins-app-apply
├── bin/jenkins-app-apply <app>      secrets on stdin → files → bin/jenkins-reload
└── bin/jenkins-reload               re-applies all JCasC in place (no restart)
/opt/apps/<app>/.env                 compose project "<app>": operator config only
```

Rules that keep apps untrusted-safe:

- **Pipelines are the platform's.** Jobs are inline `@Library('platform') appBuild/appDeploy(…)` scripts rendered by the app role. The library is trusted and loaded from `PLATFORM_REF` with no version override. Never let a job read a Jenkinsfile from an app repo — its deploy stage runs on the controller, which has the docker socket.
- **Everything the operator approves comes from the job, not from the app at REF**: hosts and secret keys are rendered at `kayra apps`. Only the compose file list is read from `app.yml` at REF.
- **Compose files come from the commit being deployed** and are admitted before `up`. The policy (`jenkins-lib/resources/platform/compose-policy.sh`, modelled on Pod Security "restricted") is an **allow-list** of service keys — extend it deliberately, never switch it back to a deny-list. On top: every service needs a memory limit, no bind mounts, foreign images/networks/volumes, Host() outside the app's hosts, Traefik names or `platform-public` aliases without the `<app>-` prefix, `platform-public` not `external`, `@internal` services, `authelia@file`. Changing it: add a case to `ci/tests/compose-policy/cases/` and run `bash ci/tests/compose-policy/run.sh`.
- **Admission runs `config --no-env-resolution`.** Otherwise Compose reads `env_file` on the controller, from any path — `/run/app-secrets/<other-app>/` included — and bakes it into the app's container. With it, `env_file` stays visible and the allow-list refuses it.
- **Two networks.** `platform-public` is Traefik + apps; `platform-internal` is Jenkins, BuildKit, registry, Authelia, with Traefik as the only bridge. Platform services go on `internal` with `traefik.docker.network=platform-internal`; never put one on `public` again, or every app can reach it. Apps can still reach each other on `platform-public`, so they must not address their own services by name across it (`api` there is anyone's) — e.g. the container name `shop-api-1`.
- **Traefik router/service/middleware names are global** — hence the mandatory `<app>-` prefix; two apps with a router called `api` would knock each other out.
- **Credential IDs are `<app>-<key>`**, and the prefix is added by the library from the job's app name, so an app cannot name another app's credential.
- **JCasC never deletes a job it stops defining** (Job DSL's `removedJobAction` is not available through JCasC). Removed apps are handled by `app-remove`; a platform job that disappears — e.g. after emptying `renovate_repositories` — is deleted by hand in the Jenkins UI. Accepted: platform jobs rarely change.
- **What is registered on a server is its set of `10-<app>.yaml` files** — `apps-prune.yml` and the registry GC both read them. Never register an app any other way.
- **Apply app config with `jenkins-app-apply`, never by recreating the controller.** Jenkins is shared; a restart kills every app's builds.
- **Never export `COMPOSE_PROJECT_NAME` on the controller** *(checked)*. Deploys pass `-p <app>`; an exported name would beat it.
- **Known gap:** the registry is unauthenticated on `platform-internal`, and BuildKit `RUN` steps reach it, so one app's build could overwrite another app's images. Fine while every app is ours or a trusted customer's; per-app registry credentials (Zot) come before the first untrusted tenant.

### Config and secrets

- Non-secret app config → `config:` in `app.yml` + value in `servers/<server>/apps/<app>.yml` (plaintext) → `/opt/apps/<app>/.env`.
- App secrets → `secrets:` in `app.yml` + value in `servers/<server>/apps/<app>.secrets.yml` (vault on hetzner and home) → Jenkins credential `<app>-<key>` → injected as env at deploy. Never in any `.env`.
- Host settings → `servers/<server>/vars.yml`, host secrets → `servers/<server>/secrets.yml` → `/opt/platform/.env` (platform) or the edge roles.
- `server.yml` → topology only. No passwords, no acme emails, no app config.
- Use `${VAR:?required}` for secrets. No `${VAR:-fallback}` for required values.
- Vault settings travel as environment: kayra sets `ANSIBLE_VAULT_PASSWORD_FILE` (or `ANSIBLE_ASK_VAULT_PASS`) on the Ansible it runs, from `vault`/`vault_password_file` in `server.yml`.

---

## Platform internals

### Auth: Authelia is the platform's, apps own their users

Authelia guards the platform's own pages (Jenkins, Traefik's dashboard) for
the operators. An app's users belong to the app and its customer: the app
brings its own login, so it runs the same
without the platform, and hiring or firing staff never needs an operator.

- **Never route an app through `authelia@file`** — the compose policy refuses
  it. Its access rules name only platform hosts, so it would answer 403
  anyway; and the app would be back to trusting identity headers, which any
  container on `platform-public` can forge.
- **The registry has no public router.** Builds push to `registry:5000` on
  `platform-internal`, the host daemon pulls from `localhost:5000`; nothing
  outside the server needs it. Do not route it again.
- **Jenkins sits behind `authelia@file`**, except `/github-webhook/` (its own
  higher-priority router; the GitHub plugin checks the HMAC). Jenkins keeps its
  local realm on top. Anything automated talks to the controller from inside —
  `bin/jenkins-api`, `docker compose exec` — never through Traefik, which would
  answer with a login redirect.
- **Do not switch Jenkins to OIDC** as its realm: `bin/jenkins-api` and the
  agent-secret bootstrap authenticate with the admin password over basic auth,
  which the OIDC realm rejects.
- **Do not set `forwardedHeaders.trustedIPs`** on a Traefik entrypoint. Authelia
  trusts `X-Forwarded-*` unconditionally on its authz endpoint; Traefik
  overwriting them is the only thing making that safe.
- Neither Authelia nor Traefik expands `${VAR}` in its own config file. Traefik's ACME email is substituted by the platform role on copy; Authelia uses the
  `template` config filter and Go templating (`{{ env "DOMAIN" }}`).

### CI: only the controller touches the docker socket

The build agent runs pipeline code checked out from arbitrary branches, so it
has **no docker socket and no docker CLI**. Builds go to a rootless `buildkitd`
over TCP and push straight to the registry.

- **Never mount `/var/run/docker.sock` into `jenkins-agent`** *(checked)*. That is the thing
  this arrangement exists to prevent; it made any pushed branch host root.
- **Never add `docker` back to the agent's JCasC label** *(checked)*. It is
  `buildkit linux`. A job asking for `docker` must land on the controller.
- **The agent has no language toolchain** (git, buildctl, jq only). Apps build
  and check inside their Dockerfiles; adding Node or Go to the agent is the
  platform learning about an app.
- `appDeploy` is `agent none` with per-stage agents on purpose: checkout and
  image builds on the unprivileged agent, only admission + `compose up` on the
  controller. Do not collapse it back to a single agent.
- `resolve-images.sh` pushes to `registry:5000` and emits `localhost:5000` refs.
  Both point at the same storage; the first is reachable from containers, the
  second from the host daemon. Do not "fix" the mismatch.
- `resolve-images.sh <app> <app-root>` has two modes: `--plan` (pure git, no
  registry, no buildkit) and `--ensure <artifact>`. It refuses an `image` outside
  `<app>/`. Keep `--plan` side-effect free — both
  pipelines call it before building anything, to name their stages and to
  write `images.env`.
- **Every artifact gets a stage on every run**, cached or not. Both the stage
  and graph views key their table on stage name; a set that varies between
  runs renders incoherently. Make the *contents* conditional, never the stage.
- `moby/buildkit` ignores `BUILDKITD_FLAGS` — flags go in the container command,
  or it listens on a unix socket nothing can reach.
- **buildkitd runs under the named AppArmor profile `buildkit-rootless`**, not
  unconfined. Ubuntu 23.10+ denies unprivileged user namespaces to unconfined
  processes, so rootlesskit cannot start without it. Do **not** "fix" this by
  setting `kernel.apparmor_restrict_unprivileged_userns=0` — the profile grants
  userns to that one container and leaves the host protection intact. The
  profile is installed by the `docker` role and must load before the platform
  play.
- The platform role copies `compose/buildkit/`. Without it the
  bind mount has no source, Docker creates a **directory** where the config file
  should be, and buildkitd crash-loops. `docker restart` cannot recover that —
  the container has to be recreated.
- **`<app>/build` is triggered by the GitHub push webhook** (hourly poll as
  fallback), which polls the SCM its last run checked out with `poll: true`.
  A build of another branch therefore also checks out the app's ref with
  `poll: true` (`@watch` workspace), or the job would stop watching main. When
  green on the app's ref it starts `<app>/deploy` with **that exact SHA**. Both
  post a commit status (`jenkins/build`, `jenkins/deploy`) linking to the run.
- **A Forgejo is configured as code** by `forgejo-config` (`forgejo_config` in the server's `vars.yml`): users and SSH keys, organizations (`orgs: [{name, owner, visibility}]` — an organization's visibility is its packages' too, so a private one keeps internal images private), runners (`runners: [{name, scope}]`; without a scope a runner serves every repo on the instance), repos (created inside their organization, private from the start where their settings say so), collaborators, Actions secrets, webhooks, push mirrors. It adds and adopts, never deletes.
- **A repo on GitHub or on a Forgejo works the same.** `commitStatus` posts to
  GitHub through its plugin and to any other host through Forgejo's statuses
  API (the `git-credentials` token). Forgejo tells Jenkins about a push with a
  webhook to `jenkins-controller:8080/git/notifyCommit?url=<repo>` over
  platform-internal: the controller allows that without a token only to
  trigger polling, and Traefik never routes it. Renovate takes
  `renovate_platform: forgejo`, `renovate_endpoint`, `renovate_git_url:
  endpoint` (clone over the internal address, not the public one Forgejo's API
  reports) and an `allowInternal` host rule for a Forgejo, and runs on
  platform-internal to reach it. Off GitHub it needs `renovate_github_com_token`
  (public read only) for versions published on GitHub.
- **Jenkins reads `GIT_TOKEN` and `RENOVATE_TOKEN` from files** in
  `/opt/platform/platform-secrets/` (`${readFile:…}`), so a new one needs a
  reload, not a restart. The platform role writes them from `git_token` /
  `renovate_token`; where the server's own Forgejo hosts the repos,
  `forgejo_config.tokens` mints them instead — checked every setup, minted
  again when missing or revoked, never in the vault.
- **Job parameters are declared twice on purpose**: in the Job DSL
  (`casc-app.yaml.j2`) and in the pipeline. A JCasC reload regenerates jobs
  from the DSL, and Jenkins silently drops passed parameters a job does not
  define — build → deploy and Rollback would then ship the branch head, not
  the requested commit. The library also falls back to the app's ref, for a
  job's very first run.
- **Releases are the source of truth for GC and rollback.** Every successful
  deploy writes `$JENKINS_HOME/releases/<app>/<time>-<sha>.env`. The nightly
  `platform-registry-gc` keeps what the newest 10 of those (plus running
  containers) reference and deletes the rest — by digest, never a digest a kept
  tag shares, and never in an app that has no releases yet. `rollback` offers
  the same records and starts `<app>/deploy`.
- Registry `garbage-collect` only runs with the registry stopped (upstream:
  unsafe while pushing). The GC script stops and restarts it itself.
- **Every version is pinned exactly** *(checked for images)* — images, base images, `buildctl`, Jenkins
  and its plugins (`plugins.txt` is the full dependency closure, not just what
  we asked for), Ansible collections (`ansible/requirements.yml`),
  OpenTofu providers (the committed `.terraform.lock.hcl`). Updates arrive as
  Renovate PRs (`renovate.json`, job `platform-renovate` on each server with
  `renovate_repositories`); no
  floating tags such as `latest` or `lts`.

See the site's `concepts/ci-isolation.md` for what is still reachable.

### Checks: the rules above, enforced

The workflow `.github/workflows/checks.yml` runs on every pull request and push to `main`: shellcheck, yamllint, ansible-lint (production
profile), `tofu fmt`/`validate`, the compose-policy cases, the kayra CLI's
types, lint and tests, and the rules marked *(checked)* in this file. It is a
Docker build of `ci/checks/Dockerfile`; the last `RUN` is
`ci/checks/run.sh`.

- **The repo's own CI is the forge's** (GitHub Actions here; a fleet on Forgejo uses
  Forgejo Actions), not the platform's Jenkins: Jenkins builds and deploys apps.

- **Two parts:** `run.sh --platform` checks the engine (`kayra`) on
  its own; `run.sh --fleet <dir>` checks a fleet against it (its YAML, stacks,
  Terraform, and that the engine names none of its apps). Here both run; once
  kayra has its own repo, each repo runs its part. A rule about the engine's
  files is a platform check, one about `servers/` a fleet check.
- **Turning a rule into a check:** add a `rule_*` function to `run.sh`, prove it
  fails on a planted violation, mark the rule *(checked)* here. Rules without a
  check stay prose on purpose — not everything greps.
- **No private key is committed** *(checked)*: keys, certs and state stay gitignored, secrets go in a vault.
- **A linter finding you disagree with** goes into its config
  (`ansible/.ansible-lint`, `ci/checks/yamllint.yml`)
  with the reason, never into an inline ignore without one.
- Locally: `docker build -f ci/checks/Dockerfile .` (the platform part, as the workflow runs it). A fleet adds itself as a named context: `--build-context fleet=<fleet> --build-arg CHECKS="--platform --fleet /fleet"`.

### When to re-run what

| Changed | Re-run |
|---|---|
| Host config (`defaults.yml`, `vars.yml`, `secrets.yml`) | `kayra setup <name>` |
| App values (`apps/<app>.yml`, `apps/<app>.secrets.yml`), or an app's secrets/config/subdomains in `app.yml` | `kayra apps <name>` |
| App code or compose files | nothing — push; the next deploy takes them from the commit |
| Everything (fresh server) | `kayra up <name>` |
| Config changes only, no re-provision | `kayra deploy <name>` |

---

## Host setup: cloud-init is minimal on purpose

`cloud-init.yml.tpl` creates the hostname and the `deploy` user, nothing else.
Packages, Docker (pinned to a major via `docker_version` and `apt-mark hold`;
logs rotated through `/etc/docker/daemon.json`), swap and SSH hardening
live in the `common`/`docker` roles, because those run on every deploy and
cloud-init never runs again. Don't add host setup back to cloud-init — it
cannot reach existing servers, so it becomes a second, drifting copy.

## TLS — same Traefik config, two cert sources

| Env | Cert source |
|---|---|
| Local, VM | mkcert wildcard in `.cache/certs/` under the fleet root (gitignored), copied by the platform role |
| Home network (`target: home`, `acme_dns: hetzner` in `vars.yml`) | Let's Encrypt via DNS-01 in the `dns` Hetzner project, a certificate per hostname (token `acme_dns_token`, vaulted); a NAS's Caddy (a stack of the fleet) can take one wildcard the same way |
| Production | Let's Encrypt via Traefik ACME (HTTP-01) |

- Every Traefik-routed service: `entrypoints=websecure` + `tls.certresolver=le`. `web` is 301-redirect + ACME only.
- **Never `tls=true` on a deployed router** *(checked)*. The entrypoint's default `certResolver` only applies to routers with *no* TLS section; `tls=true` is one, so ACME never runs and prod serves `TRAEFIK DEFAULT CERT`. Where mkcert covers the host, Traefik skips ACME on its own.
- Mac calls use `https://` (mkcert CA trusted). Ansible-on-VM tasks use `validate_certs: false`.
- Local dev and the multipass VM share one mkcert dir with different domains. `scripts/local/certs.sh` regenerates whenever the cert does not cover the requested domain — never check only that the file exists.
- `acme_email` (in `servers/defaults.yml`) is the Let's Encrypt contact for every server.

---

## The docs site

`site/` is published to https://yunuseon.github.io/kayra/ by `docs.yml` on every push to `main` that touches it (`cd site && npm ci && npm run dev` locally).

- **Diagrams come from one model**, `site/model/*.c4` ([LikeC4](https://likec4.dev)): elements and relationships once, views select from them. A change to what talks to what — a new service, a moved boundary, a new network — changes the model in the same PR; never draw a diagram by hand. `npx likec4 validate model` in `site/`.
- **Pages** are Markdown/MDX in `site/src/content/docs/`; a view goes in with `<LikeC4View viewId="…" client:only="react" />`.
- The site is its own npm project (`site/package.json`), never part of the published package.

## Stack & conventions

- **Reverse proxy:** Traefik v3.7. Platform subdomains: `auth.`, `traefik.`, `jenkins.`; apps claim their own (e.g. `www.`, `api.`). Platform subdomains live in `hosts.conf`, app ones in each `app.yml` — `scripts/local/setup-hosts.sh`, `scripts/local/certs.sh` and the app role all read those, so they cannot drift.
- **Auth:** Authelia at `auth.<domain>`, passkeys. Staff only, one `admin` group, users in a vault-rendered YAML file. See the site's `concepts/authentication.md`.

## Code style

- No comments unless WHY is non-obvious. Names narrate the code.
- No defensive code for impossible cases. Validate at boundaries.
- No speculative abstractions. No backwards-compat shims.
- Match scope. Bug fix ≠ surrounding cleanup.

## Communication style

- Direct, terse. No filler. No closing summaries.
- Dark humor + bilingual DE/EN fine — match register.
- Exploratory questions: 2-3 sentences + recommendation + main tradeoff. Don't implement without alignment.
- Architecture reviews: honest diagnosis, name smells, propose cleaner shape. No rubber-stamping.

---

## Common pitfalls (don't repeat these)

1. **Stale config after changes** — see "When to re-run what" table above.
2. **`${VAR:-fallback}` for required values** — masks misconfiguration. Use `${VAR:?required}`.
3. **Putting config in `server.yml`** — it holds topology only. Host settings → `servers/<name>/vars.yml`, secrets → `secrets.yml`. App values → `servers/<name>/apps/<app>.yml` (config) and `<app>.secrets.yml`.
4. **Giving an app its own pipeline, Ansible or JCasC** — an app is `app.yml` + Dockerfiles. Anything an app needs from the platform becomes a field of the contract, handled generically by the `app` role or the library.
5. **`http://` URLs through Traefik** — 301-redirected. Use `https://`. VM tasks use `validate_certs: false`.
6. **Traefik service on `entrypoints=web`** — `web` is 301 + ACME only. Use `websecure` + `tls.certresolver=le`.
7. **App-specific anything under `kayra`** — recipes, names, paths. Apps are data in their own repositories.
8. **Relative paths in OpenTofu that end up in generated files** (SSH key paths, inventory paths) — `templatefile()`/module-passed relative paths resolve against whichever module's directory contains the call, not wherever the string was built. Any path written into content another tool reads later (Ansible inventory, `local_file`) must be `abspath()`-wrapped. This exact bug shipped three times in one sitting — `${DOCKER_VERSION}` colliding with Terraform's `${...}` interpolation in `cloud-init.yml.tpl`, a wrong `../..` depth in `prod`'s `inventory_path`, and the same in the new `multipass-instance` module — all invisible until something was actually applied.

---

## Useful commands

```bash
# Servers
kayra status                  # list all + status
kayra up shop-test            # provision + deploy everything
kayra deploy shop-test        # re-push config (no re-provision)
kayra setup shop-test         # host layer only
kayra apps shop-test          # apps only
kayra ssh shop-test           # SSH in
kayra hosts shop-test         # /etc/hosts (sudo, multipass only)
kayra down shop-test          # destroy

# Production
kayra deploy shop-prod        # re-push config
ansible-vault edit servers/shop-prod/apps/shop.secrets.yml
ansible-vault edit servers/shop-prod/secrets.yml
```

Don't push to `main` directly — servers load the pipeline library from it.
