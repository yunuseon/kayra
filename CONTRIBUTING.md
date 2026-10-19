# Contributing to kayra

Thanks for wanting to help. kayra is small and opinionated, so for anything
bigger than a fix, open an issue first and say what you want to change and
why — it saves both of us a pull request that cannot be merged.

## Before you start

Read [CLAUDE.md](CLAUDE.md). It holds the rules the platform rests on (the app
contract, CI isolation, the compose policy, TLS) and why they exist; several
look arbitrary until you know what broke without them.

## Making a change

```bash
npm ci
npm run typecheck && npm run lint && npm test     # the CLI
docker build -f ci/checks/Dockerfile .            # everything the CI checks
```

- One concern per pull request; the description says what changed and why.
- The CLI is strict TypeScript (no `any`, no `as` outside `cli/src/core/fleet/brand.ts`,
  no mutation) — the linter will tell you.
- A change to what a command does updates its golden case
  (`cli/test/golden/record.sh`); review the diff.
- A new rule from CLAUDE.md that can be checked becomes a check in
  `ci/checks/run.sh`, proven to fail on a planted violation.

## Sign-off (DCO)

Every commit carries a `Signed-off-by` line, certifying the
[Developer Certificate of Origin](https://developercertificate.org/): that you
wrote the change or have the right to submit it under the project's license.

```bash
git commit -s
```

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE).
