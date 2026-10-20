variable "fleet_root" {
  description = "The fleet's directory (the one holding servers/): the module reads servers/<server>/server.yml and each app's app.yml from .cache/apps"
  type        = string
}

variable "server" {
  description = "The platform server whose hosts these are"
  type        = string
}

variable "zone" {
  description = "The DNS zone the records go in: the server's domain, or a domain it is under"
  type        = string
}

variable "address" {
  description = "The server's IPv4 address, e.g. from its OpenTofu state"
  type        = string
}

variable "ttl" {
  description = "The records' TTL in seconds"
  type        = number
  default     = 300
}
