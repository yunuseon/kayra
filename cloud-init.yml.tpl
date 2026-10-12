#cloud-config
# Only what Ansible needs to get in. Everything else (packages, Docker, swap,
# SSH hardening) is the common and docker roles' job: they run on every
# deploy, while this runs once on first boot and can never be re-applied.

hostname: ${hostname}

users:
  - name: deploy
    groups: sudo
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys:
      - ${ssh_pubkey}
