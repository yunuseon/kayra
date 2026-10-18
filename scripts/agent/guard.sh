#!/usr/bin/env bash
# =============================================================================
# guard.sh — Claude Code's PreToolUse hook on Bash, in kayra and every fleet
# (.claude/settings.json): an AI agent may build, test and read freely, but a
# command that changes something real waits for the operator to approve it,
# in that moment.
#
# Reads the hook's JSON on stdin; prints a permissionDecision with the reason
# for the commands below: "ask" in a mode that shows the operator a prompt
# (default, acceptEdits, plan), "deny" in one that approves by itself (auto,
# dontAsk, bypassPermissions) or an unknown one, where an "ask" would let the
# command through unseen. Denied, the agent stops and says so; the operator
# runs the command, or switches the session to Manual for it.
#   - kayra commands that change a server (up, provision, setup, deploy,
#     apps, adopt, down, app purge|deploy|rollback, job) unless --dry-run or
#     the server is a multipass one (its server.yml under the project)
#   - ansible / ansible-playbook against an inventory, ansible-vault reading
#     or writing a vault
#   - merging a PR, API writes (gh api / tea api with PUT, PATCH, DELETE),
#     deleting or editing a repository, publishing a release or a package
#   - git push of main or a tag, a force push, deleting a remote branch
#   - tofu / terraform apply, destroy, import, state changes
#   - destructive commands over SSH (rm, docker rm/stop/prune/down, systemctl…)
# Anything else: no output, the normal permission flow.
#
# It reads the command's text, so it stops mistakes and instructions smuggled
# in through files or web pages, not a determined adversary: a script it does
# not read runs whatever it contains. Cases: ci/tests/guard/run.sh.
# =============================================================================
set -uo pipefail

input="$(cat)"
command="$(jq -r '.tool_input.command // empty' <<< "$input" 2>/dev/null)"
[ -n "$command" ] || exit 0
mode="$(jq -r '.permission_mode // empty' <<< "$input" 2>/dev/null)"
project="${CLAUDE_PROJECT_DIR:-$PWD}"

ask() {
    case "$mode" in
        default|acceptEdits|plan) decision=ask reason="guard: $1" ;;
        *) decision=deny reason="guard: $1. This session approves by itself (${mode:-no permission mode}), so the guard refuses instead of asking: tell the operator, who runs it or switches the session to Manual for it." ;;
    esac
    jq -n --arg decision "$decision" --arg reason "$reason" \
        '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: $decision, permissionDecisionReason: $reason}}'
    exit 0
}
has() { grep -qE -- "$1" <<< "$command"; }

# ── kayra changing a server ─────────────────────────────────────────────────
kayra='(^|[;&|(` ]|/)(kayra|kayra\.js|main\.ts|main\.js)'
verbs='(up|provision|setup|deploy|apps|adopt|down|hosts|job|app (purge|deploy|rollback))'
if has "${kayra} +(--[a-z-]+ +)*${verbs}( |$)" && ! has '--dry-run'; then
    # The server: the word after the verb (after the app subcommand for app …).
    server="$(grep -oE -- "${kayra} +(--[a-z-]+ +)*${verbs} +[a-z0-9][a-z0-9-]*" <<< "$command" | head -1 | awk '{print $NF}')"
    target=""
    [ -z "$server" ] || [ ! -f "${project}/servers/${server}/server.yml" ] \
        || target="$(sed -n 's/^target: *\([a-z]*\).*/\1/p' "${project}/servers/${server}/server.yml")"
    [ "$target" = multipass ] || ask "kayra changes ${server:-a server}${target:+ (target ${target})}"
fi
# kayra serve runs any command on any server from a browser, where this guard sees none of them.
has "${kayra} +(--[a-z-]+ +)*serve( |$)" && ask "kayra serve runs commands on every server from a browser, out of this guard's sight"

# Local API writes can change any server; the guard cannot inspect their JSON safely.
if has 'https?://(127\.0\.0\.1|localhost)(:[0-9]+)?/api(/|[?" ])' \
    && { has 'curl .*((-X|--request)[ =]*(POST|PUT|PATCH|DELETE)|(-d|--data[a-z-]*|--json|--form)([ =]|$))' \
         || { has 'fetch[ (]' && has '(POST|PUT|PATCH|DELETE)'; }; }; then
    ask "a local kayra API write can change a real server"
fi

# ── Ansible and the vaults ──────────────────────────────────────────────────
has '(^|[;&|( ])ansible-vault +(decrypt|view|edit|encrypt|encrypt_string|rekey|create)( |$)' \
    && ask "ansible-vault opens or writes a vault"
has '(^|[;&|( ])ansible(-playbook)? .*(-i|--inventory)[ =]' && ask "ansible runs against an inventory"

# ── The forges ──────────────────────────────────────────────────────────────
has '(^|[;&|( ])(gh|tea) +(pr|pulls) +merge( |$)' && ask "a pull request is merged"
has '(^|[;&|( ])(gh|tea) +api .*(-X|--method)[ =]*(PUT|PATCH|DELETE)' && ask "a forge API write"
has '(^|[;&|( ])gh +repo +(delete|edit|rename|archive)( |$)' && ask "a repository is changed or deleted"
has '(^|[;&|( ])gh +release +(create|delete|edit|upload)( |$)' && ask "a release is published or changed"
has '(^|[;&|( ])npm +publish( |$)' && ! has 'npm +publish.*--dry-run' && ask "a package is published"

# ── git push of what others build on ────────────────────────────────────────
if has '(^|[;&|( ])git +push( |$)'; then
    has 'git +push.*( |:)(main|master)( |$)' && ask "main is pushed"
    has 'git +push.*( --tags| --follow-tags| refs/tags/| v[0-9])' && ask "a tag is pushed (a release)"
    has 'git +push.*( -f( |$)| --force| \+)' && ask "a force push"
    # A push that names no branch pushes the current one: main, if that is where we are.
    case "$(git branch --show-current 2>/dev/null)" in
        main|master) has 'git +push( +-[a-zA-Z-]+)*( +origin)?( *$|[;&|])' && ask "main is pushed (the current branch)" ;;
    esac
    has 'git +push.*( --delete| -d( |$)| :[^ ])' && ask "a remote branch or tag is deleted"
fi

# ── OpenTofu / Terraform ────────────────────────────────────────────────────
has '(^|[;&|( ])(tofu|terraform) +(-chdir=[^ ]+ +)?(apply|destroy|import|state +(rm|mv|push|replace-provider)|taint|untaint|force-unlock)( |$)' \
    && ask "OpenTofu changes infrastructure or state"

# ── Destructive commands on a server ────────────────────────────────────────
if has '(^|[;&|( ])(kayra +ssh|ssh) '; then
    has '(rm +-|docker +(volume|image|system|container|network) +(rm|prune)|docker +(rm|stop|kill|restart)( |$)|compose +(down|stop|rm|restart|kill)( |$)|systemctl +(stop|restart|disable|mask)|reboot|shutdown|apt(-get)? +(install|remove|purge)|ufw |iptables )' \
        && ask "a destructive command over SSH"
fi
exit 0
