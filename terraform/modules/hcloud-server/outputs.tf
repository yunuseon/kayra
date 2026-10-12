output "ipv4_address" {
  description = "Public IPv4 address of the server"
  value       = hcloud_server.this.ipv4_address
}

output "server_id" {
  description = "Hetzner server ID"
  value       = hcloud_server.this.id
}

output "server_name" {
  description = "Server name"
  value       = hcloud_server.this.name
}

output "inventory_path" {
  description = "Path to the generated Ansible inventory"
  value       = local_file.ansible_inventory.filename
}
