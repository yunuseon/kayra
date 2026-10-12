# =============================================================================
# Hetzner Cloud Firewall Module
# Creates a firewall with standard web server rules.
# =============================================================================

terraform {
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.45"
    }
  }
}

resource "hcloud_firewall" "this" {
  name = var.name

  # SSH
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.ssh_allowed_ips
  }

  # HTTP
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  # HTTPS
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  # Anything else the server's kind needs open to the world (e.g. WireGuard).
  dynamic "rule" {
    for_each = var.extra_rules
    content {
      direction  = "in"
      protocol   = rule.value.protocol
      port       = rule.value.port
      source_ips = ["0.0.0.0/0", "::/0"]
    }
  }

  labels = var.labels
}
