# kayra

A self-hosted app platform and the CLI that runs it. Traefik, Authelia,
Jenkins, a registry and rootless BuildKit on each server, set up with OpenTofu
and Ansible; apps live in their own repositories and are built and deployed
from there — a push to an app's branch is a deploy.

kayra is the engine. A **fleet** is its configuration: a repository holding
`servers/`, one folder per server (`server.yml`, `vars.yml`, `secrets.yml`,
`apps/`, `terraform/` or a hand-written inventory). kayra knows no fleet and
no app by name.

| Where | What |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | how everything fits together, and the rules that keep it working — read first |
| [`docs/app-contract.md`](docs/app-contract.md) | what an app provides and what it may not do |
| [`docs/authentication.md`](docs/authentication.md) | staff login (Authelia), adding people, recovery |
| [`docs/ci-isolation.md`](docs/ci-isolation.md) | why app code cannot reach the host or the platform |

## Prerequisites

Node 24, `yq`, `jq`, OpenTofu, Ansible, and for local test servers Multipass
and `mkcert` (`brew install yq jq opentofu ansible mkcert nss && mkcert -install`).
Git credentials that can read the apps' repositories (`gh auth login && gh auth setup-git`).
Then the CLI: `npm ci --prefix cli && (cd cli && npm link)`, and `kayra doctor`
in a fleet to see what is still missing.

## Use

From anywhere in a fleet:

```bash
kayra status              # every server + status
kayra up shop-test        # provision + set up everything
kayra deploy shop-prod    # host setup + apps, no re-provision (from main only)
kayra ssh shop-prod
kayra down shop-test
```

## Layout

```
.
├── ansible/          # playbooks per server kind, roles
├── compose/          # the platform's compose stack (Traefik, Authelia, Jenkins, registry, BuildKit)
├── terraform/        # OpenTofu modules (hcloud, multipass)
├── ci/               # pipeline library, platform jobs, compose policy, checks
├── cli/              # kayra, the CLI
├── scripts/          # local/ (the operator's machine) and server/ (/opt/platform/bin)
└── docs/
```

Private until a license is chosen.
