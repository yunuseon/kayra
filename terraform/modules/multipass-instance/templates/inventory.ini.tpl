[servers]
${hostname} ansible_host=${ssh_host} ansible_port=${ssh_port} ansible_user=${ssh_user} ansible_ssh_private_key_file=${ssh_key_path}

[servers:vars]
ansible_ssh_common_args=-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
