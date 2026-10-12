# =============================================================================
# Hetzner Cloud Server Module
# Provisions a VPS with SSH key and cloud-init.
# =============================================================================

terraform {
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.45"
    }
  }
}

# ---------------------------------------------------------------------------
# SSH key
# ---------------------------------------------------------------------------
resource "hcloud_ssh_key" "deploy" {
  name       = "${var.name}-deploy"
  public_key = var.ssh_public_key
}

# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------
resource "hcloud_server" "this" {
  name        = var.name
  server_type = var.server_type
  image       = var.image
  location    = var.location
  ssh_keys    = [hcloud_ssh_key.deploy.id]

  firewall_ids = var.firewall_ids

  user_data = templatefile("${path.module}/../../../cloud-init.yml.tpl", {
    hostname   = var.name
    ssh_pubkey = var.ssh_public_key
  })

  labels = var.labels

  # cloud-init runs once, at creation, and Hetzner replaces the server for any
  # change to these. Editing the template (or adopting a server that was never
  # created by us) must not destroy it; Ansible converges existing servers.
  lifecycle {
    ignore_changes = [user_data, ssh_keys, image]
  }
}

# ---------------------------------------------------------------------------
# Ansible inventory file
# ---------------------------------------------------------------------------
resource "local_file" "ansible_inventory" {
  content = templatefile("${path.module}/templates/inventory.ini.tpl", {
    hostname     = var.name
    ssh_host     = hcloud_server.this.ipv4_address
    ssh_port     = 22
    ssh_user     = "deploy"
    ssh_key_path = var.ssh_private_key_path
  })
  filename = var.inventory_path
}
