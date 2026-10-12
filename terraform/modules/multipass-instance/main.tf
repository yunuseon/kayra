# =============================================================================
# Multipass Instance Module
# Provisions a local VM via Multipass with the same cloud-init as production.
# Generates a dedicated, disposable SSH keypair for the instance — unlike
# the hcloud-server module, which expects the operator's own persistent key.
# =============================================================================

terraform {
  required_providers {
    multipass = {
      source = "todoroff/multipass"
    }
    tls = {
      source = "hashicorp/tls"
    }
    local = {
      source = "hashicorp/local"
    }
  }
}

resource "tls_private_key" "deploy" {
  algorithm = "ED25519"
}

resource "local_sensitive_file" "private_key" {
  content         = tls_private_key.deploy.private_key_openssh
  filename        = "${var.ssh_key_dir}/${var.name}_ed25519"
  file_permission = "0600"
}

resource "local_file" "public_key" {
  content  = tls_private_key.deploy.public_key_openssh
  filename = "${var.ssh_key_dir}/${var.name}_ed25519.pub"
}

# ---------------------------------------------------------------------------
# Instance
# ---------------------------------------------------------------------------
resource "multipass_instance" "this" {
  name   = var.name
  image  = var.image
  cpus   = var.cpus
  memory = var.memory
  disk   = var.disk

  cloud_init = templatefile("${path.module}/../../../cloud-init.yml.tpl", {
    hostname   = var.name
    ssh_pubkey = tls_private_key.deploy.public_key_openssh
  })

  wait_for_cloud_init = true
}

# ---------------------------------------------------------------------------
# Ansible inventory file
# ---------------------------------------------------------------------------
resource "local_file" "ansible_inventory" {
  content = templatefile("${path.module}/templates/inventory.ini.tpl", {
    hostname     = var.name
    ssh_host     = multipass_instance.this.ipv4[0]
    ssh_port     = 22
    ssh_user     = "deploy"
    ssh_key_path = local_sensitive_file.private_key.filename
  })
  filename = var.inventory_path
}
