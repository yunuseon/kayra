---
name: kayra-release
description: Cut a release of kayra (the npm package @yunuseon/kayra) - version bump PR, checks, merge, tag vX.Y.Z, the release workflow publishing to npmjs.org, and checking the published package. Use this whenever kayra changes are merged and need to reach fleets, when the user says "release", "cut a release", "tag it", "publish kayra", "ship 0.x", or asks how to get merged kayra work onto servers - a fleet only gets kayra changes through a release.
---

# Releasing kayra

A fleet runs the kayra version its `package.json` pins, from npmjs.org, so
merged work reaches no server until it is released. A release is a version
bump on `main`, a tag `v<version>` on the bump's merge commit, and
`.github/workflows/release.yml`, which publishes that tag to npm.

## Before anything: don't touch the user's checkout

The user works in the same checkouts in parallel: their own branch,
uncommitted changes, sometimes mid-task. Do all of this in a **separate git
worktree off `origin/main`**, and run every step with absolute paths inside
it. Write the steps as one script under `set -euo pipefail` with one command
per line. A guard such as `[ -z "$(git status --short)" ] && …` protects only
what is inside its `&&` chain: anything after a `;` runs regardless, and that
is how writes once landed in the user's working tree. If a step needs the
user's checkout (it rarely does here), stop and ask.

## 1. What goes into this release

- `git log --oneline v<last>..origin/main` and the merged PRs since the last tag.
- Check that every PR you count is really on `main`: a PR stacked on another
  branch merges into **that** branch (`gh pr view <n> --json baseRefName`).
  It happened once: the PR was merged, its work never reached `main`.
- Pick the version (0.x):
  - **patch** for fixes;
  - **minor** for a new command, a new setting, a behaviour change (for example
    `deploy` newly ending with `verify`), and anything breaking for fleets.
  - A breaking change lists exactly what a fleet must change, in the release
    commit and the PR. Fleets read it when they bump.

## 2. The bump PR

In the worktree:

```bash
git -C "$W" switch -c release-<version>
npm --prefix "$W" version <version> --no-git-tag-version   # package.json + package-lock.json only
git -C "$W" add package.json package-lock.json
git -C "$W" commit -s -F <message file>                      # DCO sign-off; the message summarises the PRs
git -C "$W" push -u origin release-<version>
gh pr create --repo yunuseon/kayra --base main --head release-<version> --title "<version>" --body-file <file>
gh pr checks release-<version> --repo yunuseon/kayra --watch --interval 20
```

Write commit messages and PR bodies to a file first (quoted heredoc):
backticks inside `-m "…"` or a double-quoted `--body` are executed by the
shell.

## 3. Merge and tag

`main` is protected: it changes only through a PR with green `checks`, for
admins too. Merging and pushing a tag both ask the operator (kayra's guard);
that is expected, say what you are doing.

```bash
gh pr merge <n> --repo yunuseon/kayra --merge --delete-branch
merge="$(gh pr view <n> --repo yunuseon/kayra --json mergeCommit --jq .mergeCommit.oid)"
git -C "$W" fetch -q origin && git -C "$W" checkout -q "$merge"
grep '"version"' "$W/package.json"          # must be the new version
git -C "$W" tag v<version>                  # lightweight, on the merge commit, like every earlier tag
git -C "$W" push origin v<version>
```

Release tags are protected (a ruleset): once pushed, a tag cannot be moved or
deleted. A wrong tag is fixed by the next patch release, not by retagging.
So check the commit before you tag it.

## 4. Watch it publish

```bash
run="$(gh run list --repo yunuseon/kayra --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$run" --repo yunuseon/kayra --exit-status
npm view @yunuseon/kayra@<version> version   # may lag a minute after the run: retry for ~2 minutes
```

Then look inside the published package for what this release added, not
just at its version. The fleets get the package, not the repo, and only the
paths in `package.json`'s `files` ship:

```bash
d="$(mktemp -d)" && (cd "$d" && npm pack @yunuseon/kayra@<version> --silent && tar -tzf *.tgz | grep -E '<new files>')
```

Test-only paths (`test/`, `ci/`) are meant to stay out.

## 5. Afterwards

- Remove the worktree and the local branch.
- The release reaches servers through each fleet: that is the **kayra-rollout**
  skill. Say so, and say whether servers need a deploy at all (a release that
  only changes the CLI or the agent tooling changes nothing on servers).
