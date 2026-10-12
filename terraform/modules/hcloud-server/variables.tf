variable "name" {
  description = "Server name"
  type        = string
}

variable "server_type" {
  description = "Hetzner server type (e.g., cx22, cx32)"
  type        = string
  default     = "cx22"
}

variable "image" {
  description = "OS image"
  type        = string
  default     = "ubuntu-24.04"
}

variable "location" {
  description = "Hetzner datacenter location"
  type        = string
  default     = "nbg1"
}

variable "ssh_public_key" {
  description = "SSH public key for the deploy user"
  type        = string
}

variable "ssh_private_key_path" {
  description = "Path to the SSH private key (for inventory generation)"
  type        = string
}

variable "firewall_ids" {
  description = "List of firewall IDs to attach"
  type        = list(number)
  default     = []
}

variable "labels" {
  description = "Labels to attach to the server"
  type        = map(string)
  default     = {}
}

variable "inventory_path" {
  description = "Path to write the Ansible inventory file"
  type        = string
  default     = "./inventory.ini"
}
