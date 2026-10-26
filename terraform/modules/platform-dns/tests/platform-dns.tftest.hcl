mock_provider "hcloud" {}

variables {
  fleet_root = "./tests/fleet"
  address    = "192.0.2.10"
}

# The platform's hosts and every app's route hosts, once each.
run "every_host_once" {
  command = plan

  variables {
    server = "shop"
    zone   = "example.com"
  }

  assert {
    condition     = output.hosts == sort(["api.example.com", "auth.example.com", "blog.example.com", "deploy.example.com", "traefik.example.com", "www.example.com"])
    error_message = "Unexpected hosts: ${jsonencode(output.hosts)}"
  }

  assert {
    condition     = hcloud_zone_rrset.a["www"].name == "www" && one(hcloud_zone_rrset.a["www"].records).value == "192.0.2.10"
    error_message = "www is not an A record to the server"
  }
}

# A server under the zone: its names carry the rest of its domain.
run "domain_under_the_zone" {
  command = plan

  variables {
    server = "nested"
    zone   = "example.com"
  }

  assert {
    condition     = hcloud_zone_rrset.a["www"].name == "www.shop" && hcloud_zone_rrset.a["deploy"].name == "deploy.shop"
    error_message = "Names under shop.example.com in example.com should end in .shop"
  }
}

run "domain_outside_the_zone" {
  command = plan

  variables {
    server = "shop"
    zone   = "example.org"
  }

  expect_failures = [hcloud_zone_rrset.a]
}

# An app the fleet has not cloned: no guessing its hosts, a pointer to kayra doctor.
run "app_not_cloned" {
  command = plan

  variables {
    server = "uncloned"
    zone   = "example.com"
  }

  expect_failures = [hcloud_zone_rrset.a]
}

# A server running a monitor serves its page, status.<domain>, too.
run "monitor_page" {
  command = plan

  variables {
    server = "watching"
    zone   = "example.com"
  }

  assert {
    condition     = contains(output.hosts, "status.example.com")
    error_message = "status should be a host where the server runs a monitor"
  }
}

# A server redirecting its bare domain (apex_redirect) serves that too: "@" in its own zone.
run "bare_domain" {
  command = plan

  variables {
    server = "redirecting"
    zone   = "example.com"
  }

  assert {
    condition     = contains(output.hosts, "example.com") && hcloud_zone_rrset.a["@"].name == "@"
    error_message = "The bare domain should be an A record named @: ${jsonencode(output.hosts)}"
  }
}

# Under the zone, the bare domain's name is the rest of it.
run "bare_domain_under_the_zone" {
  command = plan

  variables {
    server = "redirecting-nested"
    zone   = "example.com"
  }

  assert {
    condition     = contains(output.hosts, "shop.example.com") && hcloud_zone_rrset.a["@"].name == "shop"
    error_message = "shop.example.com in example.com should be named shop"
  }
}
