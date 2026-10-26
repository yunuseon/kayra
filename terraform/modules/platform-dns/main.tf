# =============================================================================
# A platform server's DNS: an A record for each host it serves, derived from
# the fleet, never listed by hand. The platform's own subdomains (kayra's
# hosts.conf), every route host of every app in server.yml, as the app's
# app.yml in the fleet's clone (.cache/apps, which kayra doctor fills) says,
# and the bare domain where the server redirects it (apex_redirect in
# vars.yml). A new route host in an app is a new record on the next apply.
# =============================================================================

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.70"
    }
  }
}

locals {
  descriptor = yamldecode(file("${var.fleet_root}/servers/${var.server}/server.yml"))
  domain     = local.descriptor.domain
  apps       = try(local.descriptor.apps, [])

  manifests = {
    for app in local.apps :
    app.name => "${var.fleet_root}/.cache/apps/${app.name}/${try(app.path, ".")}/app.yml"
  }
  uncloned = [for name, manifest in local.manifests : name if !fileexists(manifest)]

  # status only where the server runs a monitor, which serves it; the bare
  # domain only where it redirects (apex_redirect).
  vars_file = "${var.fleet_root}/servers/${var.server}/vars.yml"
  monitored = fileexists(local.vars_file) ? try(yamldecode(file(local.vars_file)).monitor, null) != null : false
  apex      = fileexists(local.vars_file) ? try(yamldecode(file(local.vars_file)).apex_redirect, "") != "" : false
  platform_subdomains = [
    for sub in [
      for line in split("\n", file("${path.module}/../../../hosts.conf")) :
      split(" ", trimspace(line))[0] if trimspace(line) != "" && !startswith(trimspace(line), "#")
    ] : sub if sub != "status" || local.monitored
  ]
  app_subdomains = flatten([
    for name, manifest in local.manifests :
    fileexists(manifest) ? [for route in try(yamldecode(file(manifest)).routes, []) : route.host] : []
  ])
  subdomains = toset(concat(local.platform_subdomains, local.app_subdomains))

  # A host's name in the zone: www under ippo-club.net in ippo-club.net is www;
  # under shop.example.com in example.com it is www.shop. The bare domain is
  # "@" in its own zone, else the rest of it (shop).
  suffix = local.domain == var.zone ? "" : trimsuffix(local.domain, ".${var.zone}")
  names = merge(
    { for sub in local.subdomains : sub => local.suffix == "" ? sub : "${sub}.${local.suffix}" },
    local.apex ? { "@" = local.suffix == "" ? "@" : local.suffix } : {},
  )
}

resource "hcloud_zone_rrset" "a" {
  for_each = local.names

  zone    = var.zone
  name    = each.value
  type    = "A"
  ttl     = var.ttl
  records = [{ value = var.address }]

  lifecycle {
    precondition {
      condition     = local.domain == var.zone || endswith(local.domain, ".${var.zone}")
      error_message = "${var.server}'s domain ${local.domain} is not in the zone ${var.zone}."
    }
    precondition {
      condition     = length(local.uncloned) == 0
      error_message = "No app.yml in .cache/apps for ${join(", ", local.uncloned)}: run kayra doctor in the fleet, which clones every app, then apply again."
    }
  }
}
