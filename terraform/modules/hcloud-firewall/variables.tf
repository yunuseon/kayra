variable "name" {
  description = "Firewall name"
  type        = string
}

variable "ssh_allowed_ips" {
  description = "CIDR ranges allowed to SSH (default: anywhere)"
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "extra_rules" {
  description = "Additional inbound rules open to everyone, e.g. [{protocol = \"udp\", port = \"51820\"}]"
  type        = list(object({ protocol = string, port = string }))
  default     = []
}

variable "labels" {
  description = "Labels to attach to the firewall"
  type        = map(string)
  default     = {}
}
