#!/usr/bin/env bash
# Runs scripts/agent/guard.sh against every case below, once per permission
# mode: "ask" cases must come back with permissionDecision "ask" where the
# operator sees a prompt and "deny" where the session approves by itself (or
# names no mode), "pass" cases with no output in every mode. The fixture
# project has a multipass server (lab) and a hetzner one (prod).
#   bash ci/tests/guard/run.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
guard="${here}/../../../scripts/agent/guard.sh"
failed=0

project="$(mktemp -d)"
trap 'rm -rf "$project"' EXIT
mkdir -p "${project}/servers/lab" "${project}/servers/prod"
printf 'kind: platform\ntarget: multipass\ndomain: lab.test\n' > "${project}/servers/lab/server.yml"
printf 'kind: platform\ntarget: hetzner\ndomain: prod.example.com\n' > "${project}/servers/prod/server.yml"

# The current branch matters to a bare `git push`: these cases run in a repo on main.
repo="${project}/repo"
git init -q -b main "$repo"

while IFS='|' read -r expect command; do
    expect="$(xargs <<< "$expect")"
    command="${command# }"
    [ -n "$expect" ] && [ "${expect:0:1}" != "#" ] || continue
    for mode in default acceptEdits plan auto dontAsk bypassPermissions ""; do
        want="$expect"
        case "${expect}/${mode}" in ask/default|ask/acceptEdits|ask/plan) ;; ask/*) want=deny ;; esac
        # An MCP case is the tool's name, then its input as JSON; any other is a Bash command.
        if [[ "$command" == mcp__* ]]; then call="$(jq -n --arg t "${command%% *}" --argjson i "${command#* }" '{tool_name: $t, tool_input: $i}')"
        else call="$(jq -n --arg c "$command" '{tool_name: "Bash", tool_input: {command: $c}}')"; fi
        out="$(cd "$repo" && jq --arg m "$mode" '. + (if $m == "" then {} else {permission_mode: $m} end)' <<< "$call" \
            | CLAUDE_PROJECT_DIR="$project" bash "$guard")"
        got=pass
        [ -z "$out" ] || got="$(jq -r '.hookSpecificOutput.permissionDecision' <<< "$out")"
        if [ "$got" != "$want" ]; then echo "FAIL  ${mode:-no mode}: expected ${want}, got ${got}: ${command} ${out}"; failed=1; fi
    done
    echo "ok    ${expect}  ${command}"
done <<'CASES'
# kayra on real servers asks; on multipass, with --dry-run, or reading, it does not
ask  | kayra deploy prod
ask  | kayra setup prod
ask  | kayra apps prod
ask  | kayra up prod
ask  | kayra down prod
ask  | kayra adopt prod
ask  | kayra app deploy prod shop
ask  | kayra app rollback prod shop 0123abc
ask  | kayra app purge prod shop
ask  | kayra job prod gc
ask  | cd ~/Work/x && kayra deploy prod 2>&1 | tail -3
ask  | node ~/Work/kayra/cli/src/main.ts deploy prod
ask  | node node_modules/@yunuseon/kayra/bin/kayra.js deploy prod
ask  | kayra deploy unknown-server
pass | kayra deploy lab
pass | kayra up lab
pass | kayra --dry-run deploy prod
pass | kayra deploy prod --dry-run
pass | kayra verify prod
pass | kayra validate
pass | kayra status
pass | kayra plan prod
pass | kayra app runs prod shop
pass | kayra app logs prod shop
pass | kayra app check .
pass | kayra ssh prod -- docker ps
# kayra serve acts out of sight of the guard: starting it asks
ask  | kayra serve
ask  | kayra serve --port 7700 --no-open
ask  | node ~/Work/kayra/cli/src/main.ts serve
ask  | kayra serve --api --no-open
ask  | kayra serve --ui --api
ask  | curl -X POST http://127.0.0.1:7700/api/operations/deploy -d '{}'
ask  | curl --json '{}' http://localhost:7700/api/operations/setup
ask  | curl -XPOST http://127.0.0.1:7700/api/runs/r1/answers
ask  | curl -X DELETE http://127.0.0.1:7700/api/sessions/s1
ask  | node -e "fetch('http://127.0.0.1:7700/api/operations/deploy', {method: 'POST'})"
pass | curl http://127.0.0.1:7700/api/operations
pass | node -e "fetch('http://127.0.0.1:7700/api/fleet')"
pass | curl -X POST https://example.com/api/operations/deploy
# The MCP tools of kayra: the same rules, read from their JSON input
ask  | mcp__kayra__deploy {"server": "prod"}
ask  | mcp__kayra__setup {"server": "prod", "dryRun": false}
ask  | mcp__kayra__down {"server": "prod"}
ask  | mcp__kayra__app_deploy {"server": "prod", "app": "shop"}
ask  | mcp__kayra__ssh_exec {"server": "prod", "command": ["uptime"]}
ask  | mcp__kayra__deploy {"server": "unknown-server"}
ask  | mcp__kayra__deploy {"server": "../lab"}
ask  | mcp__kayra__deploy {}
ask  | mcp__kayra__certs {"domain": "shop.test"}
ask  | mcp__kayra__something_new {"server": "prod"}
pass | mcp__kayra__deploy {"server": "lab"}
pass | mcp__kayra__down {"server": "lab"}
pass | mcp__kayra__deploy {"server": "prod", "dryRun": true}
pass | mcp__kayra__verify {"server": "prod"}
pass | mcp__kayra__plan {"server": "prod"}
pass | mcp__kayra__status {}
pass | mcp__kayra__validate {}
pass | mcp__kayra__app_runs {"server": "prod", "app": "shop"}
pass | mcp__kayra__app_log {"server": "prod", "app": "shop"}
pass | mcp__other__deploy {"server": "prod"}
# Ansible and the vaults
ask  | ansible-vault decrypt --output - servers/prod/secrets.yml
ask  | ansible-vault view servers/prod/secrets.yml
ask  | ansible-vault edit servers/prod/secrets.yml
ask  | x=$(ansible-vault decrypt --vault-password-file ~/.p --output - f) && echo ok
ask  | printf x | ansible-vault encrypt --output f -
ask  | ansible servers -i servers/prod/inventory.ini -m shell -a uptime
ask  | ansible-playbook -i servers/prod/inventory.ini site.yml
pass | ansible-galaxy collection install -r requirements.yml
pass | ansible-lint ansible/
# The forges
ask  | gh pr merge 12 --merge --delete-branch
ask  | tea pr merge 155 --login alaz --style merge
ask  | gh api -X PATCH repos/o/r/hooks/1/config -f url=x
ask  | tea api --login alaz -X DELETE /repos/o/r
ask  | gh repo delete o/r --yes
ask  | gh release create v1.0.0
ask  | npm publish
pass | gh pr create --base main --head x --title t --body b
pass | gh pr view 12 --json state
pass | gh api repos/o/r/issues/1
pass | tea api --login alaz /repos/o/r/commits/abc/status
pass | npm publish --dry-run
# git push
ask  | git push origin main
ask  | git push -q origin v0.11.0
ask  | git push --tags
ask  | git push --force origin feature
ask  | git push origin --delete old-branch
pass | git push -q -u origin feature-branch
ask  | git push
ask  | git push -q
ask  | git push origin
pass | git pull -q
# OpenTofu
ask  | tofu apply
ask  | tofu -chdir=servers/prod/terraform destroy
ask  | tofu state rm module.x
ask  | terraform import a.b c
pass | tofu plan -input=false
pass | tofu -chdir=x init -input=false
pass | tofu fmt -check
# Destructive over SSH
ask  | kayra ssh prod -- docker volume rm platform_jenkins-home
ask  | kayra ssh prod -- 'cd /opt/platform && docker compose restart authelia'
ask  | ssh deploy@203.0.113.9 sudo systemctl restart docker
ask  | kayra ssh prod -- 'rm -rf /opt/x'
pass | kayra ssh prod -- 'cd /opt/platform && docker compose ps'
pass | kayra ssh prod -- ls /opt/platform/runs
# Everyday work passes
pass | npm test
pass | git commit -s -F msg.txt
pass | docker build -f ci/checks/Dockerfile .
pass | bash test/lab/upgrade.sh
CASES
exit "$failed"
