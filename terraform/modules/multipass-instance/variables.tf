variable "name" {
  description = "Instance name"
  type        = string
}

variable "image" {
  description = "Multipass image alias"
  type        = string
  default     = "24.04"
}

variable "cpus" {
  description = "Virtual CPU count"
  type        = number
  default     = 2
}

variable "memory" {
  description = "Memory size (e.g. 4G)"
  type        = string
  default     = "2G"
}

variable "disk" {
  description = "Disk size (e.g. 20G)"
  type        = string
  default     = "10G"
}

variable "ssh_key_dir" {
  description = "Directory to write the generated SSH keypair into"
  type        = string
}

variable "inventory_path" {
  description = "Path to write the Ansible inventory file"
  type        = string
  default     = "./inventory.ini"
}
