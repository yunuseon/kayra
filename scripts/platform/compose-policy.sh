#!/usr/bin/env bash
# =============================================================================
# compose-policy.sh <app> <domain> <routes> <allowed-host>... < config.json
#
# The platform's admission check, run by the deployer before every
# `docker compose up`. Input is `docker compose config --no-env-resolution
# --format json` of the app's own compose files: the fully resolved config, so
# variables, overlays and defaults cannot hide anything. Env files stay
# unresolved on purpose: the deployer would read them from its own filesystem,
# platform secrets included. Prints one line per violation and exits 1 if
# there is any.
#
# An allow-list: a service key the platform has not thought about is refused,
# rather than a new Compose feature quietly opening a hole. Modelled on
# Kubernetes' Pod Security "restricted" profile, adapted to what matters on a
# shared Docker host: an app must not reach the host, other apps, or the
# platform, and must declare how much memory it may take. Running as root
# inside the container is allowed (unlike restricted): without capabilities or
# host access it gets nothing a non-root user would not.
#
# Routing is the platform's: the app's routes (app.yml `routes`, as JSON) are
# checked here against its config, each to one of its services on one of its
# registered hosts, and the deployer writes the Traefik labels and the
# platform network from them after admission. So an app's own files carry
# neither: no `traefik.*` label, no `platform-*` network.
# =============================================================================
set -euo pipefail

usage="Usage: compose-policy.sh <app> <domain> <routes> <allowed-host>... < config.json"
app="${1:?$usage}"
domain="${2:?$usage}"
routes="${3:?$usage}"
shift 3
hosts=$(printf '%s\n' "$@" | jq -R 'select(. != "")' | jq -s .)

jq -r --arg app "$app" --arg domain "$domain" --argjson routes "$routes" --argjson hosts "$hosts" '
  def own($name): $name | startswith($app + "_");
  def platform($name): $name | startswith("platform-");
  def registry_ref: test("^(localhost|registry):5000/");
  def allowed: ["image", "command", "entrypoint", "environment", "labels",
    "networks", "volumes", "tmpfs", "healthcheck", "depends_on", "restart",
    "user", "working_dir", "init", "read_only", "expose", "stop_grace_period",
    "stop_signal", "mem_limit", "mem_reservation", "cpus", "deploy"];

  . as $root |
  (.services // {} | to_entries[] | .key as $svc | .value as $s |
    (
      ($s | keys - allowed | .[] | "\(.) is not allowed"),
      ($s.deploy // {} | keys - ["resources", "placement", "replicas"] | .[] | "deploy.\(.) is not allowed"),
      (if ($s.deploy.resources.reservations.devices // []) | length > 0
        then "deploy.resources.reservations.devices is not allowed" else empty end),
      (if ($s.mem_limit // $s.deploy.resources.limits.memory) == null
        then "no memory limit (set mem_limit)" else empty end),
      ($s.networks // {} | to_entries[] | .key as $net | .value // {} |
        (keys - ["aliases"] | .[] | "networks.\($net).\(.) is not allowed")),
      ($s.volumes // [] | .[] | select(.type != "volume" and .type != "tmpfs")
        | "\(.type) mount \(.source // "") -> \(.target) (named volumes only)"),
      (if ($s.image // "") | registry_ref and (test("^[^/]+/" + $app + "/") | not)
        then "image \($s.image) is outside the \($app)/ namespace" else empty end),
      ($s.labels // {} | keys[] | select(ascii_downcase | startswith("traefik."))
        | "label \(.): Traefik labels are the platform'"'"'s; declare routes in app.yml")
    ) | "service \($svc): \(.)"
  ),
  (.networks // {} | to_entries[] | .value as $n |
    if platform(.key) or platform($n.name // "")
    then "network \(.key): platform networks are the platform'"'"'s; it attaches routed services itself"
    elif own($n.name // "") | not
    then "network \(.key): \($n.name // "?") is not the app'"'"'s own"
    else empty end),
  (.volumes // {} | to_entries[] | .value as $v |
    (select($v.external) | "volume \(.key): external volumes are not allowed"),
    (select(($v.driver_opts // {}) | length > 0) | "volume \(.key): driver_opts are not allowed"),
    (select(own($v.name // "") | not) | "volume \(.key): \($v.name) belongs to another project")),
  (.secrets // {}, .configs // {} | to_entries[] | select(.value.file)
    | "\(.key): file-backed secrets/configs read the host filesystem"),
  ($routes | to_entries[] | .value as $r | "route \($r.host)\($r.path // "")" as $route |
    (select($root.services[$r.service] == null)
      | "\($route): no service \($r.service) in the compose files"),
    (select($hosts | index("\($r.host).\($domain)") | not)
      | "\($route): \($r.host).\($domain) is not one of this app'"'"'s hosts (kayra apps registers new ones)"))
' | { violations=$(cat); [ -z "$violations" ] || { echo "$violations"; exit 1; }; }
