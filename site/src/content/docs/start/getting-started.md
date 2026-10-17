---
title: Getting started
description: Install kayra and point it at a fleet.
sidebar:
  order: 1
---

kayra is `0.x`: in production on its author's own servers, and the fleet format
may still change between releases. Expect to read the code.

## Install

You need Node 24, `yq`, `jq`, OpenTofu and Ansible — plus Multipass and
`mkcert` for a local test server:

```bash
brew install yq jq opentofu ansible mkcert nss && mkcert -install
npm install -g @yunuseon/kayra
```

## A fleet

A fleet is a git repository that describes your servers and pins the kayra
version it runs:

```
my-fleet/
├── package.json          # devDependencies: { "@yunuseon/kayra": "<exact version>" }
└── servers/
    ├── defaults.yml      # what is the same on every server
    └── shop-test/        # one folder per server — see The fleet
```

```bash
npm install -D -E @yunuseon/kayra
```

Any `kayra` on your PATH hands over to the version the fleet pins, so a fleet
always runs the release it was tested with — on the operator's machine and,
since the server runs what that release copies to it, on every server.

## First server

```bash
kayra doctor              # tools, vault passwords, what is still missing
kayra up shop-test        # provision, set up the host, register the apps
kayra status              # every server and whether a machine exists
```

Every command can print its plan instead of running it: `--dry-run`.

Next: [the fleet](../../concepts/fleet/) — what goes into a server's folder —
and [the app contract](../../concepts/app-contract/).
