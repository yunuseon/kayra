output "ipv4_address" {
  description = "Primary IPv4 address of the instance"
  value       = multipass_instance.this.ipv4[0]
}

output "instance_name" {
  description = "Multipass instance name"
  value       = multipass_instance.this.name
}

output "inventory_path" {
  description = "Path to the generated Ansible inventory"
  value       = local_file.ansible_inventory.filename
}

output "ssh_private_key_path" {
  description = "Path to the generated SSH private key"
  value       = local_sensitive_file.private_key.filename
}
