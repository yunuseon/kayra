output "firewall_id" {
  description = "Firewall ID"
  value       = hcloud_firewall.this.id
}

output "firewall_name" {
  description = "Firewall name"
  value       = hcloud_firewall.this.name
}
