#!/usr/bin/env bash
# =============================================================================
# compose-policy.sh <app> <allowed-host>... < config.json
#
# The platform's admission check, run on the controller before every
# `docker compose up`. Input is `docker compose config --no-env-resolution
# --format json`: the fully resolved config, so variables, overlays and
# defaults cannot hide anything. Env files stay unresolved on purpose: the
# controller would read them from its own filesystem, platform secrets
# included. Prints one line per violation and exits 1 if there is any.
#
# An allow-list: a service key the platform has not thought about is refused,
# rather than a new Compose feature quietly opening a hole. Modelled on
# Kubernetes' Pod Security "restricted" profile, adapted to what matters on a
# shared Docker host: an app must not reach the host, other apps, or the
# platform, must not claim anyone else's hostnames or Traefik names, and must
# declare how much memory it may take. Running as root inside the container is
# allowed (unlike restricted): without capabilities or host access it gets
# nothing a non-root user would not.
# =============================================================================
set -euo pipefail

app="${1:?Usage: compose-policy.sh <app> <allowed-host>... < config.json}"
shift
hosts=$(printf '%s\n' "$@" | jq -R . | jq -s .)

jq -r --arg app "$app" --argjson hosts "$hosts" '
  def own($name): $name | startswith($app + "_");
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
        (keys - ["aliases"] | .[] | "networks.\($net).\(.) is not allowed"),
        (select($root.networks[$net].name == "platform-public") | .aliases // [] | .[]
          | select(startswith($app + "-") | not)
          | "alias \(.) on platform-public must start with \($app)-")),
      ($s.volumes // [] | .[] | select(.type != "volume" and .type != "tmpfs")
        | "\(.type) mount \(.source // "") -> \(.target) (named volumes only)"),
      (if ($s.image // "") | registry_ref and (test("^[^/]+/" + $app + "/") | not)
        then "image \($s.image) is outside the \($app)/ namespace" else empty end),
      ($s.labels // {} | to_entries[] |
        (select(.key | test("^traefik\\.(tcp|udp)\\.")) | "\(.key) (HTTP routers only)"),
        (select(.key | test("^traefik\\.http\\.(routers|services|middlewares)\\."))
          | (.key | split(".")[3]) as $name
          | select($name | startswith($app + "-") | not)
          | "\(.key): Traefik names must start with \($app)-"),
        (select(.value | test("@internal")) | "\(.key) references an @internal service"),
        (select(.key | test("^traefik\\.http\\.routers\\.[^.]+\\.middlewares$"))
          | select(.value | split(",") | map(gsub("\\s"; "")) | index("authelia@file"))
          | "\(.key): authelia@file is the platform'"'"'s login; apps bring their own"),
        (select(.key | test("^traefik\\.http\\.routers\\.[^.]+\\.rule$")) | .key as $k | .value as $rule |
          ([$rule | scan("Host\\(`([^`]*)`\\)") | .[0]]) as $claimed |
          if ($rule | test("HostRegexp|HostSNI")) then "\($k): only Host() rules are allowed"
          elif ($claimed | length) == 0 then "\($k): rule must name a Host()"
          else ($claimed[] | select(. as $h | $hosts | index($h) | not)
                | "\($k): host \(.) is not one of this app'"'"'s")
          end)
      )
    ) | "service \($svc): \(.)"
  ),
  (.networks // {} | to_entries[] | .value as $n |
    (select(($n.name // "") != "platform-public" and (own($n.name // "") | not))
      | "network \(.key): \($n.name // "?") is neither the app'"'"'s own nor platform-public"),
    (select($n.name == "platform-public" and $n.external != true)
      | "network \(.key): platform-public is the platform'"'"'s, declare it external: true")),
  (.volumes // {} | to_entries[] | .value as $v |
    (select($v.external) | "volume \(.key): external volumes are not allowed"),
    (select(($v.driver_opts // {}) | length > 0) | "volume \(.key): driver_opts are not allowed"),
    (select(own($v.name // "") | not) | "volume \(.key): \($v.name) belongs to another project")),
  (.secrets // {}, .configs // {} | to_entries[] | select(.value.file)
    | "\(.key): file-backed secrets/configs read the host filesystem")
' | { violations=$(cat); [ -z "$violations" ] || { echo "$violations"; exit 1; }; }
