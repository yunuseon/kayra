# kayra

A self-hosted app platform for running other people's apps safely, one server
per customer, all of it as code.

kayra sets up a server (Hetzner, a machine at home, or a local Multipass VM)
with Traefik, Authelia, a private registry, rootless BuildKit and a small
deployer, and then builds and deploys apps from their own repositories: a push
to an app's branch is a deploy. Servers are described in a git repository (a **fleet**);
kayra is the engine that turns that description into running machines.

```
   kayra (this repo, versioned)            a fleet (your repo)          apps (their repos)
 ┌──────────────────────────────┐      ┌───────────────────────┐    ┌──────────────────┐
 │ CLI: kayra up/setup/apps/…   │◀─────│ servers/<name>/       │    │ app.yml          │
 │ Ansible, OpenTofu, compose   │ pins │   server.yml, vars,   │    │ Dockerfiles      │
 │ the deployer: build, deploy  │      │   secrets (SOPS)      │    └────────┬─────────┘
 │ compose admission policy     │      │ package.json → kayra  │             │ built & deployed
 └──────────────────────────────┘      └───────────────────────┘             ▼ by the platform
```

## Why

- **Apps are untrusted by design.** Builds run in rootless BuildKit with no
  Docker socket; an app's compose files are admitted against an allow-list
  modelled on Kubernetes' Pod Security "restricted" before anything starts;
  platform services sit on a network apps cannot reach.
- **Apps are plain data.** An app is an `app.yml` and its Dockerfiles — no
  pipeline, no Ansible. It runs without the platform locally and can leave
  with its customer at any time.
- **One server per customer, reproducible.** Everything about a server lives in
  its folder of the fleet; secrets per server in SOPS, reviewable and checked without the key; machines from
  OpenTofu; every version pinned and kept current by Renovate.
- **Small and self-hosted.** No cloud provider beyond a VPS; it runs on a
  single Hetzner box or at home.

## Status

`0.x`: in production on its author's own servers, and the fleet format may
still change between releases. Expect to read the code.

## Quick start

You need Node 24, `yq`, `jq`, OpenTofu and Ansible (and Multipass plus
`mkcert` for a local test server):

```bash
brew install yq jq opentofu ansible mkcert nss && mkcert -install
npm install -g @yunuseon/kayra
```

A fleet is a git repository with a `package.json` that pins kayra
(`npm install -D -E @yunuseon/kayra`), a `servers/defaults.yml` and one folder per
server under `servers/` — see [CLAUDE.md](CLAUDE.md#the-fleet-contract-one-folder-per-server)
for what goes where. Any `kayra` on your PATH then runs the version the fleet
pins:

```bash
kayra doctor              # what is still missing
kayra up shop-test        # provision + set up a server, register its apps
kayra deploy shop-prod    # host setup + apps, no re-provision (from main only)
kayra status
kayra serve               # the fleet in the browser
kayra serve --ui --api     # browser and the local program API
kayra mcp                 # every command as a tool, for an agent (from .mcp.json)
```

## Documentation

| | |
|---|---|
| [**The docs site**](https://yunuseon.github.io/kayra/) | architecture diagrams, getting started, the fleet, the CLI |
| [The app contract](https://yunuseon.github.io/kayra/concepts/app-contract/) | what an app provides and what it may not do |
| [CI isolation](https://yunuseon.github.io/kayra/concepts/ci-isolation/) | why app code cannot reach the host or the platform |
| [Authentication](https://yunuseon.github.io/kayra/concepts/authentication/) | staff login (Authelia), adding people, recovery |
| [Local API](https://yunuseon.github.io/kayra/reference/api/) | program access, authentication, operations, runs and terminal sessions |
| [MCP](https://yunuseon.github.io/kayra/reference/mcp/) | every operation as a tool for an agent such as Claude Code, and what asks |
| [Upgrade to 0.17.0](https://yunuseon.github.io/kayra/reference/upgrading-0-17/) | replacing `kayra ui`, client changes and the fleet dependency bump |
| [`CLAUDE.md`](CLAUDE.md) | how everything fits together, and the rules that keep it working |

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
Security problems: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Yunus Öztürk
