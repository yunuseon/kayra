# kayra — AI assistant guide

You are working in **kayra**: a self-hosted app platform (Traefik + Authelia + Registry + BuildKit + a small deployer, deployed to Hetzner, home machines or Multipass VMs via Ansible/OpenTofu) and the CLI that runs it. kayra is the **engine**; a **fleet** — a repository holding `servers/`, one folder per server — is its configuration, and apps live in their own repositories as plain data. kayra knows no fleet and no app by name.

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
| `ansible/`, `compose/`, `terraform/`, `cloud-init.yml.tpl`, `hosts.conf` | The platform: Traefik, Authelia, Registry, BuildKit, the builder and the deployer, Ansible roles, OpenTofu modules, cloud-init |
| `cli/src/deployer/` | The deployer: the builder and deployer daemons and their `ctl` — the one pipeline every app runs |
| `ci/` | The compose-policy tests, the checks (`ci/checks/`) |
| `cli/` | kayra, the CLI: every server's lifecycle — the only layer that touches both host setup and apps |
| `site/` | The docs site (Starlight on GitHub Pages): pages in `src/content/docs/`, the architecture model in `model/*.c4` (LikeC4) |

Shell scripts live in three places, by **where they run**:

| Path | Runs on |
|---|---|
| `scripts/local/` | the operator's machine, called by kayra (`require-main.sh`, `certs.sh`, `setup-hosts.sh`, …); a script reading the fleet's files takes `FLEET_ROOT` from kayra |
| `scripts/server/` | the server: installed to `/opt/platform/bin` by the platform role (`app-apply`, `app-remove`, `app-purge`) |
| `scripts/platform/` | the builder or the deployer, copied into their images (`resolve-images.sh`, `compose-policy.sh`, `registry-gc.sh`) |

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
kayra plan shop-prod         # what provision + setup would change, changing nothing
kayra validate               # the fleet beyond its schemas (secrets, apps, stacks, routes)
kayra verify shop-prod       # does it work as users see it (deploy and up run it at the end)
kayra apps shop-test         # register every app (config, secrets, jobs)
kayra ssh shop-test          # SSH into it
kayra down shop-test         # destroy
kayra status                 # every server: address, SSH, login (--offline, --json)
kayra setup shop-prod --dry-run   # any command: print the plan, run nothing
kayra setup shop-prod -v          # any command: playbooks with Ansible's own output
kayra deploy --help               # a command's arguments, the fleet's servers, examples
```

Also `provision`, `hosts`, `adopt`, `backup test`, `app purge|runs|logs|deploy|rollback`, `job`, `certs`, and `app check [dir]`, the one command that runs outside a fleet: in an app's repository, it runs the image plan and the compose policy as the builder and the deployer do (`scripts/local/app-check.sh`, bash 3.2-safe), so a refusal shows before a push. App repos are cloned locally (`.cache/apps`) with the operator's own git credentials (`gh auth setup-git`). App development happens in each app's own repository.

- **A fleet pins its kayra:** `@yunuseon/kayra` as an exact dev dependency in the fleet's `package.json`. Whatever `kayra` is on PATH hands over to the fleet's `node_modules/@yunuseon/kayra` (`bin/kayra.js`), so the version the fleet pins is the one that runs. To try a kayra checkout against a fleet: `npm link @yunuseon/kayra` in the fleet.
- **One version for the Mac and the servers:** the server runs what the Mac's kayra copies to it — compose files, Ansible, the deployer's code and its scripts — so the version the fleet pins is the one the server runs. Nothing on the server loads kayra from git. Releases: bump `version` in `package.json`, merge, tag `v<version>` (release.yml publishes to npmjs.org).
- **A command is pure:** `(engine, server) => Result<Plan>`, a readonly list of steps: `run` (with env, and `$(…)`-style queries resolved when it runs; its stdout shown, discarded, or drawn by a `View`), a `check` (a guard stops the plan; doctor's report and go on), `confirm`, `note`. `interpret.ts` is the only code that runs anything.
- **Two roots:** the engine (`KAYRA_ROOT`, `kayra`) and the fleet (`FLEET_ROOT`, the directory holding `servers/`) are named apart everywhere, so the engine can live elsewhere (A2). kayra passes `FLEET_ROOT` to the local scripts; Ansible has `kayra_root` (above the playbooks) and `fleet_root` (above `server_dir`). Never derive one from the other.
- **Every server is validated whenever kayra loads the fleet** (`parseServer`): kind, target, domain, apps, inventory or `terraform/`, vaulting, and every file against its schema. A broken file anywhere stops every command.
- **`kayra plan <server>`** shows what `provision` and `setup` would change and changes nothing: `tofu plan`, then the setup playbook with `--check --diff`. Not tied to `main` — it previews a branch against a server. So every role must run in check mode: **a task that only reads (a lookup, a `GET`, a status command) gets `check_mode: false`**, since Ansible skips commands and `uri` there and later tasks read their results; **a file task whose content holds secrets gets `diff: false`** (or `no_log`), or `--diff` prints them.
- **`kayra verify <server>`** checks a platform server as its users see it (`scripts/local/verify.sh`): from the Mac, each name pinned to the server's address, `auth.` answers, the platform's pages send a browser to the login (a 403 means Authelia runs rules without that host), every certificate is real (never `TRAEFIK DEFAULT CERT`), an unsigned webhook is refused, every app hostname answers without 5xx; over SSH, the registrations match `server.yml`, every container runs and none is unhealthy, no app's last run failed, no alert is open. The probes retry for `VERIFY_WAIT` seconds (150) for certificates that are still coming. `deploy` and `up` run it last on platform servers, so a deploy that leaves a server broken fails. Each way a server has broken is a case in `ci/tests/verify/run.sh` (stubbed curl, openssl, ssh); a new one gets a case.
- **`kayra validate [server]`** checks what the schemas cannot: every unknown key in `secrets.yml` must be a helper `vars.yml` uses; each app's `app.yml` (from `.cache/apps`) against the fleet's values for it; `compose_stacks.stacks` against `stacks/`; `edge_routes`. Vaulted files only with the password file, apps only where cloned — otherwise noted as not checked. Each finding is `passed`, `problem` or `unchecked`, with a hint saying what to do; the view groups them per server under a mark and ends with a summary; exit 1 on a problem. The fleet's checks run it (`fleet:kayra-validate`).
- **`kayra status`** knows a server's address from its `inventory.ini` where there is one (a home server's is hand-written), else from OpenTofu's `server_ip` if the state holds a machine (`hcloud_server`, `multipass_instance`; a storage box is none). Then every server is probed at once, through `Network` (`net.ts`, the adapter): a TCP connect to SSH (2 s; refused is `off`, an on-demand SSH), and on platform servers HTTPS on `auth.<domain>/api/health`. On a terminal the table appears at once on stderr and its cells fill in (`watch`, in `ui/terminal.ts`), then the finished table goes to stdout. `--offline` asks only OpenTofu: the golden case runs it, since probes are not deterministic.
- **`--json`** on `status` and `validate`: one document on stdout, nothing on stderr; the shapes are documented in the site's CLI reference. Add fields freely; renaming or removing one is a change a release must call out.
- **Settings are a registry** (`cli/src/core/settings.ts`): every variable a role reads from a fleet, with its kinds, type, description and whether it is secret. From it come the schemas (Zod): `server.yml` and `vars.yml` strict (an unknown key is an error, with a "did you mean"), a secret in `vars.yml` refused, nested structures typed but open; `defaults.yml` any kind's settings; `secrets.yml` its known keys typed. Also the JSON Schemas for editors (`schema/`, in the package) and the docs' settings page. **A role reading a new variable from the fleet gets its entry in the same PR**, or every fleet setting it is refused; then `npm run schemas` (a test fails while `schema/` or the page are stale). A value that never varies is not a setting.
- **Golden tests:** `test/golden/record.sh <out>` runs `test/golden/cases` against a fixture fleet with ansible, tofu, ssh and the local scripts stubbed, recording argv, Ansible env, stdout and exit status; `cli-test` holds kayra to `expected/`. It was recorded from the justfiles kayra replaced, which proved the two equal. Re-record a case only for a change meant to alter it, and read the diff.
- **Output is spans of meaning, painted at the edge** (`core/present/`; the terminal's painting in `clients/cli/`): a `Line` is spans with a `Tone` (`ok`, `bad`, `muted`, …) and maybe an `href` (an OSC 8 link where `Screen.links`), never escape codes; tables with `table`/`fit` (`ui/text.ts`); `main.ts` paints each stream by its own `Screen` (`FORCE_COLOR`, `NO_COLOR`, a TTY), so tests compare plain text. **stdout is what a command reports, stderr what is around it**: `framed` puts a heading, each step (titled: every `run` has one) with its time, part headings (`partOf`: the commands a longer one is made of) and a footer on stderr, which is why the golden tests, recording stdout, never see it. `ssh`, `app` and `job` run `silent`: their output is the point. Renderers are pure; only `ui/terminal.ts` (spinner, escapes) and `main.ts` touch a stream.
- **The deployer's answers are data, drawn by kayra:** `ctl runs|rollback <app> --json` (`deployer/answers.ts`, every time ISO 8601) is what a `run` step with a `View` captures, and `ui/views.ts` draws it (`app runs`, `app rollback` without a commit; `app logs` marked, the same bytes when uncoloured). Between a kayra bump and the server's `kayra deploy` a newer kayra asks an older ctl: an answer a view cannot read is printed as it came (an older ctl refuses `rollback <app> --json`, deploying nothing). A new answer gets its type in `answers.ts`, its schema and view in `ui/views.ts`, and a case in `test/deployer/ctl.test.ts`.
- **Help is Optique's, arranged in `cli.ts`:** commands in `group()` sections (on a server, apps on a server, the whole fleet; `sectionOrder` keeps that order), a brief per command, a `description` and an examples `footer` where they help, `runOptions` for the program's brief, examples and docs link. Global options sit in a `merge` beside the commands, not in an `object` around them: `object()` drops a command's description and footer from its help page. Server names are a `choice()` with `suggest: "nearest"` (a "did you mean"), shown in help by `showChoices`. Errors come without the usage above them (`aboveError: "none"`): the root's would bury them.
- **`-v`/`--verbose` is a plan transform** (`verbose` in `commands/server.ts`): every `ansible-playbook` step gets `-v` and `ANSIBLE_STDOUT_CALLBACK=default`, so `--dry-run` and the golden tests see it.
- **Brands for every meaningful string** (`src/core/brand.ts`, the only file where `as` is allowed; arguments are minted by its Optique value parsers); errors are `Result` values, not exceptions.
- Strictest tsconfig, `typescript-eslint` strict + `eslint-plugin-functional` (no `let`, no mutation). An inline `eslint-disable` says why. Dependencies are pinned exactly (`.npmrc`).
- The checks run `cli-typecheck`, `cli-lint`, `cli-test`. Locally: `npm run typecheck|lint|test` at the root.

### Core and clients

`cli/src/` is one engine and the clients around it; lint (`no-restricted-imports` in `cli/eslint.config.ts`) keeps them apart:

- **`core/`**: the fleet, settings, plans, the interpreter, the commands, and `present/` (spans of meaning, progress as events, views as lines: data any client draws). It imports no client; of `deployer/` only types (ctl's answers are its wire format).
- **`clients/cli/`**, **`clients/api/`**, **`clients/ui/`**: the command line (Optique, the terminal's painting, frames, spinners), the HTTP API, the browser side's assets. No client imports another.
- **`main.ts`** and **`serve.ts`** compose them; **`deployer/`** runs on servers and imports neither; **`result.ts`** is shared by all (Ansible copies it next to the deployer).

Every client offers kayra's full feature set: a new operation reaches all three.

- **The catalog** (`core/operations/catalog.ts`) declares each operation once: its summary (every client's one line), scope, effect (`reads`, `changes`, `destroys`), kind (`plan`, `query`, `stream`) and input schema (plain JSON, zod). `core/operations/run.ts` is the one way in: `invocation(name, input)` checks the input; `planOf`, `query` and `stream` run it, each a table typed over every operation of its kind, so one without an implementation does not compile.
- **Interactions** (`core/interpret.ts`): questions distinguish confirmations from secrets; the CLI hides secret typing and the API records only the question. A run asks once per server for its vault password, given to Ansible by an executable helper in a private temporary directory; the helper reads the password from the child environment, and its directory is removed when the run ends. Sudo passwords reach `setup-hosts.sh` through stdin. Interactive SSH is a `session` step: the CLI inherits its terminal; other clients supply input and receive a pty through `script`. Cancellation also releases questions and terminates child process groups.
- **Coverage is compiled in:** each client maps its own input onto invocations and holds a table `satisfies Record<OperationName, …>`; the command line's is `reaches` in `clients/cli/invocation.ts`. `test/parity.test.ts` parses each and checks it lands on its operation. A new operation: its catalog entry, its implementation, then every client's table, or nothing compiles.

### Local server (`kayra serve`)

`kayra serve` starts the browser interface (`--ui`, the default), a local program API (`--api`), or both. The browser is a view of the CLI in a browser on the operator's machine, never a second control plane: the Mac holds the fleet, the vault passwords, OpenTofu's state and the SSH keys, and nothing of that moves to a server for it.

- **One engine:** `planOf` (`core/operations/run.ts`) builds the same plans as the command line; the interpreter runs them with `Io.output` (a step's output piped, no stdin) and `Io.signal` (Stop = SIGINT, SIGTERM after 10s); `reporting` (`ui/progress.ts`) is `framed` as events. Guards travel with the plans: `require-main`, `latest-state`, `down`'s typed name.
- **The server** (`cli/src/serve.ts` composing `clients/api/` and `clients/ui/`, node:http, no runtime dependency of its own): 127.0.0.1 only; admission (`auth.ts`) wants this listener's Host on every request (DNS rebinding), its Origin on cookie-authenticated writes, the launch token (a cookie named per port) on the API. A change to a server that is not multipass needs its name in the request, checked here, not only in the browser. One run per server; runs are recorded as JSON lines under the fleet's `.cache/ui/runs/`. Vault passwords are secret questions answered in the client; their answers never enter the run record.
- **The API** lives at `/api`, without a separate API version: the fleet's pinned kayra defines the contract, and upgrades replace the API and bundled UI together. `GET /operations` exposes the catalog; `POST /operations/<name>` dispatches plans, queries, streams and terminal sessions. Plans support previews, `verbose` and `dryRun`; runs replay over SSE or NDJSON. Real-server changes still require an explicit name, and the plans retain their own guards and typed confirmations.
- **Program access** is opt-in (`--api`): the launch writes `.cache/serve.json` with URL, bearer token and pid, mode 0600, and removes it on shutdown. The browser uses an HttpOnly, SameSite=Strict cookie. Every request needs this listener's Host; cookie writes need that host's exact Origin. Bearer writes require no Origin. No CORS.
- **The contract** (`clients/api/contract.gen.ts`) and OpenAPI (`clients/api/openapi.json`) are generated from the catalog and protocol schemas by `npm run contract`. `web/` imports only the generated types; the server assigns its results to them, and tests reject stale artifacts. Query serializers are typed over the complete catalog's query names.

- **`web/`** is its own npm project (Preact, `@preact/signals`, Vite; exact pins), built at `prepack` into `cli/dist/browser` (never `cli/dist/web`: that is where tsc puts the server's own modules, and the build empties its directory; 0.16.0 shipped that way and did not start), served from `web/dist` in a checkout. Same strictness as the CLI: its lint config reuses the CLI's rules from the root's `node_modules`, with signals' `.value` and the DOM's objects exempt. Pure modules (the router, the SGR parser, the run reducer, the palette's matching, the status cells) are vitest-tested; the one place a server answer takes a type is `api.ts`'s `trusted`. Dev: `kayra serve --port 7700 --no-open` beside `npm --prefix web run dev` (Vite proxies `/api` as if from kayra serve's own page).
- **The agent guard asks before `kayra serve` and local API writes**: what runs from the browser is out of its sight. Don't drive a real fleet's `kayra serve` from a browser tool either; test against a fixture fleet or a Multipass lab.
- The checks run `web-typecheck`, `web-lint`, `web-test`, `web-build`.

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
├── terraform/          main.tf etc.; terraform.tfvars gitignored; the state committed, encrypted
└── inventory.ini       generated by `kayra provision` (gitignored)
```

```yaml
# server.yml
kind: platform             # platform (Traefik, Authelia, the deployer, apps) | edge | nas
target: hetzner            # hetzner | multipass | home — gates cert source + /etc/hosts
domain: shop.example.com
vault: true
apps:
  - {name: shop, repo: https://github.com/example/shop.git, ref: main, path: .}
```

- **OpenTofu state is committed, encrypted** *(checked: `run.sh --fleet` refuses a `terraform.tfstate` that is not)*: OpenTofu's state encryption (`terraform { encryption { … } }` with a pbkdf2 key from a passphrase file outside the repo, AES-GCM), so the state is versioned and in every clone, and only the passphrase holder reads it. Commit the state after every `provision`/`down`.
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
- **The upgrade lab, before a platform change merges:** `bash test/lab/upgrade.sh` (about 15 minutes, on the Mac: Multipass, mkcert, OpenTofu, Ansible). A throwaway fleet in a temp directory brings a Multipass server up at the **last release**, deploys the fixture app (`test/lab/app`) by a signed webhook, upgrades the fleet's kayra to this checkout and `kayra deploy`s (which ends with `kayra verify`), then: a new commit by webhook, the same commit again (`CACHED`), a commit the compose policy refuses (the old one keeps serving), a rollback, the registry GC, `kayra verify`. What broke on real servers broke on upgrades, not fresh installs; a bug found there gets a step here. After a failure the VM, the fleet and the log are kept (it prints where); `--keep` keeps them after a pass too, `--from <version>` starts elsewhere. The fixture app is served over git's smart HTTP from the Mac (`test/lab/git-http.py`), which is why a multipass server may clone `http://` repos and nothing else may.
- **Testing platform changes before merging:** `npm link @yunuseon/kayra` to the branch's checkout in the fleet, and `ref: <branch>` on the app entry, against a multipass server. Only a multipass server ever runs anything but a release: `require-main.sh` refuses a hetzner or home server while the fleet's kayra is a linked checkout.
- **Hetzner servers only change from `main` as merged, with a released kayra.** Every kayra command deploys the local checkout; `require-main.sh` makes `provision`, `adopt`, `setup`, `apps` and `app purge` refuse a hetzner or home server unless the fleet's checkout is a clean `main` equal to `origin/main` (other servers' folders may be dirty — that is where test pointers live) and its kayra is the pinned package, not a link. A vault edit for prod therefore goes through a PR before it is deployed. Never add a bypass: deploying a feature branch to prod once turned the platform's own checks off there.
- **An app in its own repo** needs, once: the platform's `git_token` extended to the repo (clone, commit statuses) and the Renovate token if Renovate keeps it current, a push webhook to `https://deploy.<domain>/hook/<app>` signed with the platform's `webhook_secret` (a Forgejo on the same server: `http://builder:8080/hook/<app>`, set by `forgejo-config`), and `kayra apps <server>`. The hourly poll deploys a moved ref even without the webhook. The app's local dev never needs the platform.

---

## Apps: the contract (read before touching any app or pipeline)

An app is **data**. It never contains a pipeline, Ansible or platform config — that is what lets it move to its own repo and be handed to a customer without exposing the platform.
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
| `kayra apps <server>` | platform `app` role | reads `app.yml` + `servers/<server>/apps/<app>.yml`; fails on missing values or a platform subdomain; writes `/opt/apps/<app>/.env` (config), pipes secrets to `bin/app-apply`, writes the registration `/opt/platform/apps/<app>.json` (repo, ref, path, hosts, secret keys) |
| push to the app's ref | builder, then deployer | the forge's webhook (or the hourly poll) queues a run: the ref to a commit, each missing content-addressed image built through buildkitd (`kayra/build`), then that exact commit deployed (`kayra/deploy`) |
| a run's deploy half | deployer | the bundle from the builder (images + the compose files `app.yml` lists at the commit) checked again, **admitted** with `compose-policy.sh`, `docker compose up --wait`, the release recorded |
| `kayra app deploy\|rollback <server> <app> [ref]` | deployer, over SSH | the same run for any branch, tag or commit; rollback lists or redeploys release records |
| app dropped from `server.yml`, then `kayra apps <server>` | `bin/app-remove` (via `apps-prune.yml`) | registration first (no run starts after it), containers down, secrets, `.env`, runs and release records gone; **volumes kept** — `kayra app purge <server> <app>` deletes them, and only once the app is unregistered; the next registry GC collects its images |

On the server:

```
/opt/platform/                       compose project "platform"
├── .env                             incl. COMPOSE_FILE: plain `docker compose` works here
├── apps/<app>.json                  ← the registration, by the app role: what may deploy where
├── app-secrets/<app>/<KEY>          ← written by bin/app-apply, read by the deployer only
├── runs/<app>/<id>/{meta.json,log}  ← every run, newest 50 per app (runs/_gc, runs/_renovate: the jobs)
├── releases/<app>/<time>-<sha>.env  ← every successful deploy: rollback and GC work from these
├── deployer/                        build context of both images: Dockerfiles + app/ (code, scripts)
└── bin/app-apply <app>              secrets on stdin → files
/opt/apps/<app>/.env                 compose project "<app>": operator config only
```

Rules that keep apps untrusted-safe:

- **The pipeline is the platform's.** Every app runs the same run (`cli/src/deployer/run.ts`); nothing in an app's repository is executed except its Dockerfiles, inside BuildKit. Never let a run read a script, pipeline or hook from the app's repo.
- **Everything the operator approves comes from the registration, not from the app at the commit**: hosts and secret keys are written at `kayra apps`. Only the compose file list is read from `app.yml` at the commit.
- **Compose files come from the commit being deployed** and are admitted before `up`. The policy (`scripts/platform/compose-policy.sh`, modelled on Pod Security "restricted") is an **allow-list** of service keys — extend it deliberately, never switch it back to a deny-list. On top: every service needs a memory limit, no bind mounts, foreign images/networks/volumes, Host() outside the app's hosts, Traefik names or `platform-public` aliases without the `<app>-` prefix, `platform-public` not `external`, `@internal` services, `authelia@file`. Changing it: add a case to `ci/tests/compose-policy/cases/` and run `bash ci/tests/compose-policy/run.sh`.
- **Admission runs `config --no-env-resolution`.** Otherwise Compose reads `env_file` in the deployer, from any path — `/run/app-secrets/<other-app>/` included — and bakes it into the app's container. With it, `env_file` stays visible and the allow-list refuses it.
- **The deployer trusts nothing the builder returns.** The builder handles app code; the bundle it hands over is checked again (`bundle.ts`: the commit asked for, images only under `localhost:5000/<app>/`, compose paths relative and inside the app) before admission. Keep that check when the bundle grows.
- **Two networks.** `platform-public` is Traefik + apps; `platform-internal` is the builder, the deployer, BuildKit, registry, Authelia, with Traefik as the only bridge. Platform services go on `internal` with `traefik.docker.network=platform-internal`; never put one on `public` again, or every app can reach it. Apps can still reach each other on `platform-public`, so they must not address their own services by name across it (`api` there is anyone's) — e.g. the container name `shop-api-1`.
- **Traefik router/service/middleware names are global** — hence the mandatory `<app>-` prefix; two apps with a router called `api` would knock each other out.
- **Secrets are injected by app name**: the deployer reads `app-secrets/<app>/<KEY>` for the keys of the app it is deploying, into the environment of that app's compose commands only. An app cannot name another app's secret.
- **What is registered on a server is its set of `apps/<app>.json` files** — `apps-prune.yml`, the registry GC and both daemons read them. Never register an app any other way.
- **Never export `COMPOSE_PROJECT_NAME` in the deployer** *(checked)*. Deploys pass `-p <app>`; an exported name would beat it.
- **Known gap:** the registry is unauthenticated on `platform-internal`, and BuildKit `RUN` steps reach it, so one app's build could overwrite another app's images. Fine while every app is ours or a trusted customer's; per-app registry credentials (Zot) come before the first untrusted tenant.

### Config and secrets

- Non-secret app config → `config:` in `app.yml` + value in `servers/<server>/apps/<app>.yml` (plaintext) → `/opt/apps/<app>/.env`.
- App secrets → `secrets:` in `app.yml` + value in `servers/<server>/apps/<app>.secrets.yml` (vault on hetzner and home) → `app-secrets/<app>/<KEY>` → injected as env at deploy. Never in any `.env`.
- Host settings → `servers/<server>/vars.yml`, host secrets → `servers/<server>/secrets.yml` → `/opt/platform/.env` (platform) or the edge roles.
- `server.yml` → topology only. No passwords, no acme emails, no app config.
- Use `${VAR:?required}` for secrets. No `${VAR:-fallback}` for required values.
- Vault settings travel as environment: kayra sets `ANSIBLE_VAULT_PASSWORD_FILE` (a configured password file, or the per-run password helper) on the Ansible it runs, from `vault`/`vault_password_file` in `server.yml`.

---

## Platform internals

### Auth: Authelia is the platform's, apps own their users

Authelia guards the platform's own pages (the runs pages, Traefik's dashboard) for
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
- **`deploy.<domain>` sits behind `authelia@file`**, except `/hook/` (its own
  higher-priority router; the builder checks the HMAC). The pages are
  read-only: anything that starts a run goes through `kayra app …` over SSH,
  into the deployer's control port, which listens on its loopback only.
- **Do not set `forwardedHeaders.trustedIPs`** on a Traefik entrypoint. Authelia
  trusts `X-Forwarded-*` unconditionally on its authz endpoint; Traefik
  overwriting them is the only thing making that safe.
- Neither Authelia nor Traefik expands `${VAR}` in its own config file. Traefik's ACME email is substituted by the platform role on copy; Authelia uses the
  `template` config filter and Go templating (`{{ env "DOMAIN" }}`).
- **Authelia reads `configuration.yml` once at startup**; the platform role
  restarts it when the file changed (as it does Traefik and BuildKit for
  theirs). A new access rule that never loads is Authelia's default deny: 403.
  `users_database.yml` needs no restart — `file.watch` reloads it.

### CI: only the deployer touches the docker socket

The builder handles code from arbitrary commits and faces the internet, so it
has **no docker socket and no docker CLI**. Builds go to a rootless `buildkitd`
over TCP and push straight to the registry. The deployer holds the socket and
the app secrets, and Traefik never routes to it.

- **Traefik never mounts the Docker socket** *(checked)*. It reads containers through `socket-proxy` (`tecnativa/docker-socket-proxy`: containers, events, version, ping; no POST), on `platform-socket`, an internal network only the two join. Traefik faces the internet; the socket, even `:ro`, is the whole Docker API.
- **Only the deployer mounts the socket** *(checked)* — and socket-proxy, read-only. Never mount it into the builder: that is the thing this arrangement exists to prevent; it made any pushed branch host root.
- **The builder has no docker CLI** *(checked)* **and no language toolchain** (git, buildctl, jq, yq, node). Apps build and check inside their Dockerfiles; adding Node or Go tools for an app is the platform learning about an app.
- **The builder's two ports:** `:8080` is Traefik's (`/hook/<app>`, the pages); `:8081` (`/resolve`, `/prepare`) is reachable on platform-internal only. Never route `:8081`.
- **A run is one data flow, two halves** (`run.ts`): the ref resolved and the images built by the builder, admission + `compose up` by the deployer. Do not move the build into the deployer or the up into the builder.
- **One run per app at a time, two at once, the registry GC alone** (`queue.ts`): a push while a run goes collapses with any waiting one into one follow-up run; the GC stops the registry, so it waits for everything and nothing starts while it runs. The queue lives in memory: a restart loses waiting runs, and the hourly poll picks up a ref that moved.
- `resolve-images.sh` pushes to `registry:5000` and emits `localhost:5000` refs.
  Both point at the same storage; the first is reachable from containers, the
  second from the host daemon. Do not "fix" the mismatch.
- `resolve-images.sh <app> <app-root>` has two modes: `--plan` (pure git, no
  registry, no buildkit) and `--ensure <artifact>`. It refuses an `image` outside
  `<app>/`. Keep `--plan` side-effect free — the builder calls it before
  building anything.
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
- **Pushes arrive as webhooks** at `/hook/<app>`, proved the way the app's forge does it: HMAC-SHA256 over the body with `webhook_secret` (GitHub's `X-Hub-Signature-256`, Forgejo's `X-Forgejo-Signature`), or GitLab's `X-Gitlab-Token`, the secret itself; only a push to the app's ref queues a run. The **hourly poll** queues one for an app whose ref points at a commit no run has tried yet — a failing commit is not retried every hour. Both post commit statuses (`kayra/build`, `kayra/deploy`) linking to the run's page.
- **A Forgejo is configured as code** by `forgejo-config` (`forgejo_config` in the server's `vars.yml`): users and SSH keys, organizations (`orgs: [{name, owner, visibility}]` — an organization's visibility is its packages' too, so a private one keeps internal images private), runners (`runners: [{name, scope}]`; without a scope a runner serves every repo on the instance), repos (created inside their organization, private from the start where their settings say so; `pull_mirror: <url>` makes one a pull mirror of another forge, fetched every `mirror_interval`), collaborators, Actions secrets, webhooks (signed with `webhook_secret`), push mirrors. It adds and adopts, never deletes.
- **A repo on GitHub, GitLab or a Forgejo works the same.** Everything the
  platform asks of a forge — commit statuses, a webhook's proof — is an adapter
  in `cli/src/deployer/` (`forge.ts` picks it from the repo URL):
  `https://github.com/…` is GitHub, `https://gitlab.com/…` GitLab (group paths
  included), any other host a Forgejo, so a self-hosted GitLab is not supported
  yet. Clones need none: all three take `GIT_TOKEN` as a Basic password. A Forgejo on the same server calls
  `http://builder:8080/hook/<app>` over platform-internal. Renovate takes
  `renovate_platform: gitlab` for gitlab.com, and for a Forgejo
  `renovate_platform: forgejo`, `renovate_endpoint`, `renovate_git_url:
  endpoint` (clone over the internal address, not the public one Forgejo's API
  reports) and an `allowInternal` host rule for a Forgejo, and runs on
  platform-internal to reach it. Off GitHub it needs `renovate_github_com_token`
  (public read only) for versions published on GitHub.
- **Tokens are files** in `/opt/platform/platform-secrets/` (`GIT_TOKEN`,
  `RENOVATE_TOKEN`), read on every use, so a new one needs no restart. The
  platform role writes them from `git_token` / `renovate_token`; where the
  server's own Forgejo hosts the repos, `forgejo_config.tokens` mints them
  instead — checked every setup, minted again when missing or revoked, never in
  the vault.
- **Alerts go through a notifier** (`notify.ts`: `raise` / `resolve` per key, `decide()` pure). A failed deploy of an app's own ref (a push or the poll) or a failed job raises; a failed `kayra app deploy|rollback` does not, since whoever started it is watching; any success resolves. The one notifier today is `github-issue` (`github-issues.ts`): an issue in the `notifier.repository` opened by a GitHub App (GitHub notifies no one about their own actions), commented on and closed when resolved; open ones are kept in `/opt/platform/alerts/<key>`. Its key lives in `deployer-secrets/`, which only the deployer mounts. A notifier's failure lands in the run's log, never fails the run. A new notifier is a new `kind` in the `notifier` setting and an adapter for `Notifier`.
- **Releases are the source of truth for GC and rollback.** Every successful
  deploy writes `releases/<app>/<time>-<sha>.env`. The nightly registry GC
  (03:00, `scripts/platform/registry-gc.sh`) keeps what the newest 10 of those
  (plus running containers) reference and deletes the rest — by digest, never a
  digest a kept tag shares, and never in an app that has no releases yet.
  `kayra app rollback` offers the same records; a deleted image is rebuilt.
- Registry `garbage-collect` only runs with the registry stopped (upstream:
  unsafe while pushing). The GC script stops and restarts it itself.
- **Every version is pinned exactly** *(checked for images)* — images, base images, `buildctl`, `yq`,
  the Renovate image (`compose/deployer/Dockerfile.deployer`), Ansible collections (`ansible/requirements.yml`),
  OpenTofu providers (the committed `.terraform.lock.hcl`). Updates arrive as
  Renovate PRs (`renovate.json`, and the Renovate job on each server with
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
  Forgejo Actions), not the platform's deployer: the deployer builds and deploys apps.

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
| kayra's version (the deployer's code included) | `kayra deploy <name>` — a new version may change the app role, which `setup` alone does not run |
| Everything (fresh server) | `kayra up <name>` |
| Config changes only, no re-provision | `kayra deploy <name>` |

Upgrading to 0.8.0 in particular needs `kayra deploy` (or `kayra apps` after `setup`): `setup` removes the Jenkins registration, and only `apps` writes the deployer's.

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

- **Reverse proxy:** Traefik v3.7. Platform subdomains: `auth.`, `traefik.`, `deploy.`; apps claim their own (e.g. `www.`, `api.`). Platform subdomains live in `hosts.conf`, app ones in each `app.yml` — `scripts/local/setup-hosts.sh`, `scripts/local/certs.sh` and the app role all read those, so they cannot drift.
- **Auth:** Authelia at `auth.<domain>`, passkeys. Staff only, one `admin` group, users in a vault-rendered YAML file. See the site's `concepts/authentication.md`.
- **Ansible's output is kayra's** (`ansible/callback_plugins/kayra.py`, the `stdout_callback` in `ansible.cfg`): changed tasks (with diffs under `--diff`, so `kayra plan` shows them), failures with their message and output, what a `debug` task says, a recap; ok and skipped tasks are only counted. Indented to sit under kayra's step, the task at work redrawn in place on a terminal, holding Display's lock. A task whose result an operator must read uses `debug`, not an ok result. `ANSIBLE_STDOUT_CALLBACK=default` brings back Ansible's own. Each kind of result is a task in `ci/tests/ansible-output/play.yml` (`platform:ansible-output`); a new kind gets one.

## Working here as an AI agent

kayra, and every fleet that pins it, carries guardrails for an AI agent (Claude Code) in its `.claude/settings.json`:

- **`scripts/agent/guard.sh`**, a PreToolUse hook on Bash, makes a command that changes something real **ask** the operator first, every time — or, in a mode that approves by itself (`auto`, `dontAsk`, `bypassPermissions`), **refuse** it, since an ask there goes through unseen; the agent stops and says so, and the operator runs the command or switches the session to Manual for it:
  - kayra changing a server that is not multipass (`up`, `provision`, `setup`, `deploy`, `apps`, `adopt`, `down`, `app purge|deploy|rollback`, `job`; not with `--dry-run`);
  - `ansible`/`ansible-playbook` against an inventory, and `ansible-vault` opening or writing a vault;
  - merging a PR, forge API writes, changing or deleting a repository, releases, `npm publish`;
  - `git push` of `main` or a tag, force pushes, deleting a remote branch;
  - `tofu apply|destroy|import|state …`;
  - destructive commands over SSH.
  Building, testing, reading, `kayra verify|plan|validate|app check|app runs|app logs`, and pushing a feature branch run without asking.
- **It fails closed** in kayra (`onFailure: block`); a fleet without its kayra installed lets only `npm ci` through until then: everything else asks, or is refused in a mode that approves by itself.
- **Editing the guardrails asks too:** `.claude/**`, `scripts/agent/**`, `.github/CODEOWNERS`.
- **It reads the command's text.** It stops mistakes and instructions smuggled in through a file, an issue or a web page, not an adversary: a script it does not read runs whatever it contains. Each case is in `ci/tests/guard/run.sh` (in the checks as `platform:guard`); a new guard gets a case.
- **Procedures are skills** (`agent/skills/`, shipped in the package; `.claude/skills/` links them here): **kayra-release** (bump PR → checks → merge → tag → `release.yml` → the published package), **kayra-lab** (the upgrade lab, reading its failures), **kayra-rollout** (a release into each fleet: the bump PR in a worktree, then `kayra deploy` server by server with `verify`). A fleet links `kayra-rollout` from its pinned kayra. A procedure that went wrong gets its lesson written into its skill.
- **The user works in the same checkouts in parallel.** Changes happen in a separate git worktree off `origin/main`, steps as one `set -euo pipefail` script, never a write after `;` behind a guard.
- **CODEOWNERS** (`.github/CODEOWNERS`) names the trust boundary, the files a change to which the maintainer reviews: the compose policy, the deployer's webhook, forge and bundle code, the platform compose files, `require-main.sh`, the guard itself, the checks.
- **`main` is protected on GitHub:** changes arrive through a pull request with green checks; no direct push, no force push, no deletion, for admins too.

## Code style

- No comments unless WHY is non-obvious. Names narrate the code.
- No defensive code for impossible cases. Validate at boundaries.
- No speculative abstractions. No backwards-compat shims.
- Except at the edge: an external dependency (GitHub, a forge, a notifier, a registry API) goes behind an interface with an adapter, even with one implementation today; the decision stays pure, the service is an adapter. Skip it only when that is far more hassle than it is worth, and lean towards the interface.
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
4. **Giving an app its own pipeline, Ansible or platform config** — an app is `app.yml` + Dockerfiles. Anything an app needs from the platform becomes a field of the contract, handled generically by the `app` role or the library.
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

# Apps on a server (through its deployer, over SSH)
kayra app runs shop-prod shop             # the latest runs
kayra app logs shop-prod shop [RUN]       # a run's log, the newest by default
kayra app deploy shop-prod shop [REF]     # build + deploy a branch, tag or commit
kayra app rollback shop-prod shop [SHA]   # list earlier releases, or redeploy one
kayra job shop-prod gc                    # registry GC now (renovate [--no-prs] likewise)

# Production
kayra deploy shop-prod        # re-push config
ansible-vault edit servers/shop-prod/apps/shop.secrets.yml
ansible-vault edit servers/shop-prod/secrets.yml
```

Don't push to `main` directly — releases are cut from it.
