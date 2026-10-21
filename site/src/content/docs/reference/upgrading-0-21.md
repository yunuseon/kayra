---
title: Upgrade to 0.21.0
description: A fleet's secrets move from Ansible Vault to SOPS with age keys; how a fleet moves over, once.
---

0.21.0 reads a server's secrets from SOPS instead of Ansible Vault. Each
server has one `secrets.yml` again — the host's secrets, each app's under
`app_secrets`, OpenTofu's under `terraform` — encrypted to age keys that
`.sops.yaml` names. Why, and how it works:
[Secrets](../../concepts/fleet/#secrets).

kayra 0.21.0 refuses a fleet that still has a vault: `vault` and
`vault_password_file` in `server.yml`, an Ansible Vault `secrets.yml`, or an
`apps/<app>.secrets.yml`. Move the whole fleet in the PR that bumps kayra.

## Once per machine

```bash
brew install sops age age-plugin-se
```

## Once per fleet: its keys

The operator's key, in the Mac's Secure Enclave. Make it in a terminal of your
own (Terminal, iTerm): the Secure Enclave refuses programs started by another
app, such as an agent's shell — they can use the key, but not make one.

```bash
mkdir -p ~/.config/sops/age
age-plugin-se keygen --access-control=any-biometry-or-passcode -o ~/.config/sops/age/<fleet>.txt
```

`--access-control=none` makes a key that opens without Touch ID: for a machine
where runs happen unattended, never in the operator's own session.

A backup key, on every file, for the day the Mac is gone (the Enclave's key
dies with it): its private half goes to the password manager and nowhere else.

```bash
age-keygen 2>/dev/null   # the AGE-SECRET-KEY-1… line into the password manager; note the public key
```

`.sops.yaml` at the fleet's root names both:

```yaml
creation_rules:
  - path_regex: ^servers/[^/]+/secrets\.yml$
    age: >-
      age1se1…,
      age1…
```

## Per server

Into one file: the vault, each app's vault, and the secret variables of
`terraform/terraform.tfvars` (with the state's passphrase), merged and
encrypted without a plaintext copy on disk:

```bash
s=servers/<server>
{
  ansible-vault view --vault-password-file ~/.vault_pass "$s/secrets.yml"
  for f in "$s"/apps/*.secrets.yml; do
    [ -e "$f" ] || continue
    app="$(basename "$f" .secrets.yml)"
    echo "---"
    ansible-vault view --vault-password-file ~/.vault_pass "$f" | yq "{\"app_secrets\": {\"${app}\": .}}"
  done
} | yq eval-all '. as $doc ireduce ({}; . * $doc)' \
  | sops encrypt --filename-override "$s/secrets.yml" --input-type yaml --output-type yaml /dev/stdin > "$s/secrets.sops"
mv "$s/secrets.sops" "$s/secrets.yml"
git rm -q "$s"/apps/*.secrets.yml
```

On a multipass server `secrets.yml` may stay plaintext: move its
`apps/<app>.secrets.yml` under `app_secrets` all the same.

Then `sops edit "$s/secrets.yml"` and add OpenTofu's secrets:

```yaml
terraform:
  hcloud_token: …          # each secret variable from terraform.tfvars
  state_passphrase: …      # what ~/.tofu_pass held
```

What `terraform.tfvars` holds that is not secret (a name, a server type) stays
there, committed now (take it off `.gitignore`); OpenTofu reads both. The
state's encryption takes its passphrase from the variable:

```hcl
variable "state_passphrase" {
  type      = string
  sensitive = true
}

terraform {
  encryption {
    key_provider "pbkdf2" "fleet" {
      passphrase = var.state_passphrase
    }
    # method, state and plan as before
  }
}
```

In `server.yml`, drop `vault` and `vault_password_file`; add `age_key_file:
~/.config/sops/age/<fleet>.txt` unless the key is in SOPS's default place.

## Check, then let go of the old files

```bash
kayra validate                 # needs no key: every secret's key and type, the recipients
kayra plan <server>            # opens secrets.yml (one Touch ID); OpenTofu and Ansible change nothing
SOPS_AGE_KEY='AGE-SECRET-KEY-1…' SOPS_AGE_KEY_FILE=/dev/null sops decrypt servers/<server>/secrets.yml > /dev/null && echo "the backup key opens it"
```

Once the PR is merged and every server deployed with 0.21.0, delete
`~/.vault_pass`, `~/.tofu_pass` and the secret lines of every
`terraform.tfvars`. They are in git's history only as ciphertext under the old
vault password: a password that was weak is a reason to rotate what it held.
