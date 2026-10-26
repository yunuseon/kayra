output "records" {
  description = "Every A record, its name in the zone => address"
  value       = { for sub, rrset in hcloud_zone_rrset.a : rrset.name => var.address }
}

output "hosts" {
  description = "Every host this server serves, fully qualified"
  value       = sort([for sub in keys(local.names) : sub == "@" ? local.domain : "${sub}.${local.domain}"])
}
