---
name: kayra-lab
description: Run kayra's upgrade lab (test/lab/upgrade.sh) - a throwaway Multipass server brought up at the last release, upgraded to the kayra checkout, and taken through every deploy path - and read its result. Use this before merging any change to kayra's platform (ansible/, compose/, scripts/, cli/src/deployer/, terraform/), after a release to prove the full path from it, whenever the user asks to "test this on a VM", "run the lab", "does the upgrade work", or when a bug was found on a real server and needs a reproduction.
---

# The upgrade lab

What broke on kayra's real servers broke on **upgrades**, never on the fresh
VMs it used to be tested on: Authelia kept rules it had never loaded, an app
was left unregistered, every image was rebuilt on every run. The lab
reproduces the upgrade path end to end:

1. A temp fleet pinned to the last release (or `--from <version>`) brings a
   Multipass server up and deploys a fixture app (`test/lab/app`) by a
   signed webhook.
2. The fleet's kayra becomes this checkout; `kayra deploy` (which ends with
   `kayra verify`).
3. A new commit by webhook; the same commit again must be `CACHED`.
4. A commit the compose policy refuses: the run fails naming the bind mount,
   and the old release keeps serving.
5. `kayra app rollback` to the first release, the registry GC, `kayra verify`.

## Before you start

- Run it from a kayra checkout, or a worktree of one, that holds the change
  under test. The lab links the fleet to **that directory's working tree**,
  uncommitted changes included: say which commit and which changes it tests.
- `multipass list` shows no `kayra-lab` VM. A kept one from an earlier
  failure is torn down first (its command was printed at the end of that run).
- Multipass, mkcert, OpenTofu, Ansible, Node 24 and python3 on the Mac.

## Running it

About 15 minutes. Run it in the background with its output in a log, and
follow the phases rather than waiting blind:

```bash
bash test/lab/upgrade.sh [--from <version>] [--keep] > <log> 2>&1; echo "lab exit $?" >> <log>
```

Watch for lines starting `── ` (a phase), `✓` and `✗`, `kept for`, and
`lab exit`. Keep one watcher per log: two watchers on the same file report
every event twice. A release older than the one that allowed `http://` app
repos on multipass prints "cannot clone over http://: the app arrives with
the upgrade". The release then sets up only the platform, which is expected
for that range.

## When it fails

A failure keeps everything, the VM (`kayra-lab`), the temp fleet and the log,
and prints where. Look before you change anything:

- The lab's own log: `grep -nE 'fatal:|FAILED|✗|kayra:|rror' <lab log>`.
- What the server did: from the kept fleet directory,
  `node node_modules/@yunuseon/kayra/bin/kayra.js app runs lab sample` and
  `… app logs lab sample`.
- Then decide: **a kayra bug or a lab bug?** Most first-run failures were the
  lab's. Each was fixed in the lab, and twice the fix showed something kayra
  should handle:
  - git's dumb HTTP cannot serve the shallow clones kayra makes, so the lab
    uses smart HTTP (`test/lab/git-http.py`);
  - a repo URL without `owner/name` matches no forge, so its webhooks were
    refused;
  - a bind mount appended to the end of the compose file landed under
    `networks:`, so compose rejected the file before the policy saw it;
  - `verify` did not yet understand an app registered but never deployed:
    that was a gap in kayra, fixed there, with a case added.
- Tear the kept VM down with the printed command before the next run.

## After a pass

The VM and the temp fleet are destroyed unless `--keep`. Report the five
phases and the final `kayra verify`, and what the run covered. A bug found on
a real server, which the lab did not catch, gets a step here: the lab is
only as good as the history it encodes.
