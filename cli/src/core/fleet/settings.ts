import { z } from "zod";
import { typed } from "../../lib/typed.ts";
import { appNameSchema, domainSchema, periodSchema, repoPathSchema, repoUrlSchema, routePathSchema, serviceNameSchema, subdomainSchema } from "./brand.ts";
import { serverTargets } from "./model.ts";

/** The server kinds, each with its playbook; settings say which kinds read them. */
export const serverKinds = ["platform", "edge", "nas"] as const;
export type ServerKind = (typeof serverKinds)[number];

/**
 * One setting: a variable the roles read, set in a server's vars.yml (or once
 * for every server in defaults.yml) — or, if secret, in its secrets.yml.
 */
export type Setting = {
  readonly name: string;
  readonly kinds: readonly ServerKind[];
  readonly secret: boolean;
  readonly schema: z.ZodType;
  readonly description: string;
};

const setting = (
  name: string,
  kinds: readonly ServerKind[],
  schema: z.ZodType,
  description: string,
) => typed<Setting>({ name, kinds, secret: false, schema: schema.describe(description), description });

const secret = (
  name: string,
  kinds: readonly ServerKind[],
  schema: z.ZodType,
  description: string,
) => typed<Setting>({ name, kinds, secret: true, schema: schema.describe(description), description });

const text = z.string();
const texts = z.array(z.string());
const platform: readonly ServerKind[] = ["platform"];
const edge: readonly ServerKind[] = ["edge"];
const nas: readonly ServerKind[] = ["nas"];

/** Nested settings check the fields they know and allow others: a typo is caught at the top. */
// eslint-disable-next-line functional/prefer-immutable-types -- a Zod schema: immutable once built, but a class the rule cannot see into
const record = (fields: Readonly<Record<string, z.ZodType>>) => z.looseObject(fields);

export const settings: readonly Setting[] = [
  // Every kind that serves HTTPS
  setting("acme_email", ["platform", "edge"], text, "The Let's Encrypt account contact: expiry warnings land here."),
  setting("docker_version", ["platform", "edge"], text, "The Docker CE major the docker role pins and holds, as an apt version glob (default 5:29*)."),

  // platform: the platform role
  setting("authelia_policy", platform, z.enum(["one_factor", "two_factor"]), "What Authelia asks of staff: two_factor (default) or one_factor."),
  setting("authelia_smtp_address", platform, text, "SMTP server for Authelia's mails (passkey enrolment); empty: mails go to a file."),
  setting("authelia_smtp_username", platform, text, "SMTP user for Authelia."),
  setting("authelia_smtp_sender", platform, text, "Sender address of Authelia's mails."),
  setting("acme_dns", platform, z.enum(["", "hetzner"]), "Certificates by DNS-01 instead of HTTP-01, for a server the internet never reaches: the DNS provider (hetzner)."),
  setting("webhooks", platform, z.boolean(), "Whether a push webhook may start a deploy at once: true (default) serves deploy.<domain>/hook/<app>; false serves no such endpoint, and pushes deploy by deploy_poll."),
  setting("deploy_poll", platform, text, "When the deployer looks for pushes no webhook brought, as a five-field cron spec in the server's time (default hourly: 17 * * * *)."),
  setting("renovate_repositories", platform, texts, "owner/repo of the repos this server's Renovate job keeps up to date; the job runs only where the list is not empty."),
  setting("renovate_schedule", platform, text, "When the Renovate job runs, as a five-field cron spec in the server's time (default weekly: 0 4 * * 1)."),
  setting("renovate_platform", platform, z.enum(["github", "forgejo", "gitlab"]), "Where the repos live: github (default), forgejo or gitlab."),
  setting("renovate_endpoint", platform, text, "With a Forgejo: its API on platform-internal, e.g. http://forgejo:3000/api/v1."),
  setting("renovate_git_url", platform, z.enum(["default", "ssh", "endpoint"]), "How Renovate clones; endpoint with a Forgejo, so it uses the internal address."),
  setting("renovate_host_rules", platform, z.array(record({ matchHost: text })), "Renovate hostRules: allowInternal for a Forgejo on platform-internal, credentials for a private registry."),
  setting("vm", platform, record({ address: text, gateway: text, disk: text }), "target home: the VM kayra provision builds — fixed address (CIDR), gateway, disk size."),
  setting(
    "forgejo_config",
    platform,
    record({
      url: text,
      container: text,
      runners: z.array(record({ name: text, scope: text.optional() })).optional(),
      tokens: z.array(record({ user: text, name: text, scopes: texts, secret: text })).optional(),
      users: z.array(record({ name: text, email: text })).optional(),
      orgs: z.array(record({ name: text, owner: text, visibility: z.enum(["public", "limited", "private"]) })).optional(),
      ssh_keys: z.array(record({ user: text, title: text, key: text })).optional(),
      repos: z
        .array(
          record({
            name: text,
            settings: z.record(z.string(), z.unknown()).optional(),
            collaborators: z.array(record({ user: text, permission: text })).optional(),
            webhooks: texts.optional(),
            push_mirror: text.optional(),
            pull_mirror: text.optional(),
          }),
        )
        .optional(),
    }),
    "What this server's own Forgejo holds, as code: users, SSH keys, organizations, runners, repos (settings, collaborators, webhooks, mirrors) and the tokens it mints for the platform.",
  ),

  // platform and nas: the compose-stacks role
  setting("compose_stacks", ["platform", "nas"], record({ dir: text, stacks: texts }), "The server's own compose stacks: their directory on the server and the names under stacks/ to run."),

  // nas
  setting("nas_root", nas, text, "The only directory the NAS play writes in, asserted before any change (e.g. /volume2)."),
  setting(
    "restic_backup",
    nas,
    record({
      dir: text,
      repository: text,
      schedule: text,
      restore_test_schedule: text,
      paths: texts,
      restore_test_paths: texts.optional(),
      exclude: texts.optional(),
      keep: record({ daily: z.number(), weekly: z.number(), monthly: z.number() }).optional(),
      ssh: record({ public_key: text, host: text, user: text, port: z.number(), known_host: text }).optional(),
    }),
    "The nightly restic backup: what, where to (SFTP), when, how long kept, and the monthly restore test.",
  ),

  // edge
  setting(
    "wireguard",
    edge,
    record({ address: text, port: z.number(), peer_public_key: text, peer_allowed_ips: texts, keepalive: z.number().optional() }),
    "The tunnel into the private network: the edge's address, port, and the one peer (its key, what it may reach).",
  ),
  setting(
    "edge_routes",
    edge,
    z.array(record({ subdomains: texts, upstream: text, forwarded_headers: z.boolean().optional() })),
    "Public names the edge serves: subdomains of the domain and the upstream inside the tunnel they go to.",
  ),
  setting(
    "ntfy",
    edge,
    record({
      base_url: text,
      upstream_base_url: text.optional(),
      access: z.array(record({ user: text, topic: text, permission: z.enum(["rw", "ro", "wo", "deny"]) })),
    }),
    "An ntfy server for alerts, behind Caddy (an edge_routes entry to ntfy:80): its public base_url, who may read or publish which topic (everything else denied), and upstream_base_url (https://ntfy.sh) for iPhones, whose instant push only ntfy.sh can wake.",
  ),
  setting(
    "monitor",
    ["platform", "edge"],
    record({
      watch: texts,
      extra: z.array(record({ name: text, url: text, group: text.optional(), server: text.optional(), conditions: texts.optional() })).optional(),
    }),
    "Gatus on this server, alerting through the notifier: every minute, what kayra derives for each server in watch (its logins, pages, app routes, deploy.<domain>/health; an edge's routes; certificates) with each name pinned to that server's address, plus extra checks (Gatus conditions, default [STATUS] == 200; server pins the name to that server's address).",
  ),
  setting(
    "notifier",
    ["platform", "edge"],
    z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("ntfy"), url: text, topic: z.string().regex(/^[\w-]{1,64}$/) })]),
    "Where alerts go — the deployer's (a failed deploy of an app's ref, a failed job) and the backup check's: kind ntfy, a message to topic on the ntfy server at url when an alert opens and when it is resolved; the token in notifier_ntfy_token.",
  ),
  setting(
    "backup_check",
    edge,
    record({
      stale_after_hours: z.number(),
      repositories: z.array(record({ name: text, url: text, user: text, restore_test_max_days: z.number().optional() })),
    }),
    "The hourly check of the private network's backups: when a snapshot is stale, which repositories. Its alerts go to the notifier.",
  ),

  // Secrets
  secret("notifier_ntfy_token", ["platform", "edge"], text, "With notifier kind ntfy: the access token alerts are published with."),
  secret("git_token", platform, text, "Token the builder clones app repos with and the deployer posts commit statuses with."),
  secret("health_token", platform, text, "Bearer token a monitor reads deploy.<domain>/health with: the platform's and every app's containers, the disk and memory. Unset, there is no such page."),
  secret("webhook_secret", platform, text, "HMAC secret the apps' push webhooks (deploy.<domain>/hook/<app>) are signed with."),
  secret("renovate_token", platform, text, "Token the Renovate job opens PRs with."),
  secret("renovate_github_com_token", platform, text, "Public-read GitHub token for Renovate's lookups off GitHub."),
  secret("authelia_session_secret", platform, text, "Authelia's session secret."),
  secret("authelia_storage_encryption_key", platform, text, "Authelia's storage encryption key."),
  secret("authelia_smtp_password", platform, text, "Authelia's SMTP password."),
  secret("authelia_users", platform, z.record(z.string(), z.unknown()), "Staff accounts: name, email, argon2id password hash."),
  secret("acme_dns_token", platform, text, "With acme_dns: the DNS provider's token, for DNS-01 only."),
  secret("forgejo_admin_token", platform, text, "forgejo-config's token: admin, organization, repository, user (read and write)."),
  secret("forgejo_runner_secrets", platform, z.record(z.string(), text), "Per runner name: the 40-character secret shared by the runner and Forgejo."),
  secret("forgejo_action_secrets", platform, z.array(record({ repo: text, name: text, value: text })), "Actions secrets per repo."),
  secret("forgejo_push_mirror_credentials", platform, record({ username: text, password: text }), "The account push mirrors push with."),
  secret("compose_stack_secrets", ["platform", "nas"], z.record(z.string(), z.record(z.string(), z.unknown())), "Per stack: the variables of its .env."),
  secret("compose_registry_logins", ["platform", "nas"], z.array(record({ registry: text, username: text, password: text })), "Private registries the stacks pull from."),
  secret("restic_backup_password", nas, text, "The restic repository's password."),
  secret("restic_backup_ssh_key", nas, text, "The SSH key the backup reaches the Storage Box with."),
  secret("restic_backup_postgres_passwords", nas, z.record(z.string(), text), "Per database container: the password its dump connects with."),
  secret("ntfy_password_hashes", edge, z.record(z.string(), text), "Per ntfy user: the bcrypt hash of its password (ntfy user hash)."),
  secret("ntfy_tokens", edge, z.record(z.string(), text), "Per ntfy user: an access token (ntfy token generate), e.g. the one monitors publish with."),
  secret("monitor_health_tokens", ["platform", "edge"], z.record(z.string(), text), "Per watched platform server: its health_token, which the monitor reads deploy.<domain>/health with."),
  secret("wireguard_private_key", edge, text, "The edge's WireGuard private key."),
  secret("wireguard_peer_psk", edge, text, "The tunnel's preshared key."),
  secret("backup_check_passwords", edge, z.record(z.string(), text), "Per watched repository: its read-only password."),
];

/** Ansible's own variables (connection, privilege escalation) are always allowed. */
export const isAnsibleVariable = (key: string) => key.startsWith("ansible_");

const settingsFor = (kind: ServerKind, secrets: boolean) =>
  Object.freeze(settings.filter((each) => each.secret === secrets && each.kinds.includes(kind)));

// eslint-disable-next-line functional/prefer-immutable-types -- Zod schemas: immutable once built, but classes the rule cannot see into
const shape = (chosen: readonly Setting[]) => Object.fromEntries(chosen.map((each) => [each.name, each.schema.optional()] as const));

/** vars.yml for a kind: its settings and nothing else (Ansible's own variables apart). */
// eslint-disable-next-line functional/prefer-immutable-types -- a Zod schema: immutable once built, but a class the rule cannot see into
export const varsSchema = (kind: ServerKind) => z.strictObject(shape(settingsFor(kind, false)));

/** defaults.yml: settings shared by every server, so any kind's. */
export const defaultsSchema = z.strictObject(shape(settings.filter((each) => !each.secret)));

/** apps/<app>.yml, and an app's mapping in secrets.yml's app_secrets: flat key → value. */
export const appValuesSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

/** secrets.yml's own (the host's) secrets: the known ones typed; other keys may be helpers that vars.yml references. */
// eslint-disable-next-line functional/prefer-immutable-types -- a Zod schema: immutable once built, but a class the rule cannot see into
export const secretsSchema = (kind: ServerKind) => z.looseObject(shape(settingsFor(kind, true)));

/**
 * A multipass server, a test machine by definition, may clone an app over
 * plain HTTP too: the upgrade lab serves its fixture app that way.
 */
const schemes = (target: (typeof serverTargets)[number]) => typed<readonly string[]>(target === "multipass" ? ["https://", "http://"] : ["https://"]);

/** server.yml: topology only. What it says is checked here, once: the parser, the editors' schema and the docs read it. */
/** One app in server.yml: where its code is and which branch deploys. */
export const appEntrySchema = z.strictObject({
  name: appNameSchema,
  repo: repoUrlSchema.describe("The app's repository, https://."),
  ref: z.string().optional().describe("The branch to build and deploy (default main)."),
  path: repoPathSchema.prefault(".").describe("The app's root inside the repository (default .)."),
});

export const serverSchema = z
  .strictObject({
    kind: z
      .enum(serverKinds, { error: (issue) => `kind must be ${serverKinds.join(", ")}, not '${String(issue.input)}'` })
      .default("platform")
      .describe("Which playbook: platform (default; Traefik, Authelia, the deployer, apps), edge or nas."),
    target: z
      .enum(serverTargets, { error: (issue) => `target must be ${serverTargets.join(", ")}, not '${String(issue.input)}'` })
      .describe("Where it runs: hetzner, multipass (a local VM) or home (a machine nothing creates)."),
    domain: domainSchema.describe("The server's domain; platform subdomains and the apps' hang off it."),
    age_key_file: z.string().optional().describe("The age identity that opens secrets.yml (SOPS); without it, SOPS's own default (SOPS_AGE_KEY_FILE, ~/.config/sops/age/keys.txt)."),
    apps: z
      .array(appEntrySchema)
      .default([])
      .describe("The apps this server runs (platform only)."),
  })
  .superRefine((server, context) => {
    if (server.kind !== "platform" && server.apps.length > 0)
      context.addIssue({ code: "custom", path: ["apps"], message: "apps run on platform servers only" });
    server.apps.forEach((app, index) => {
      if (!schemes(server.target).some((scheme) => app.repo.startsWith(scheme)))
        context.addIssue({
          code: "custom",
          path: ["apps", index, "repo"],
          message: `repo must be an https:// URL${server.target === "multipass" ? " (or http:// on multipass)" : ""}`,
        });
    });
  });

/** One of an app's public routes: the platform writes its Traefik router, the app no label. */
const routeSchema = z.strictObject({
  host: subdomainSchema.describe("Its hostname, <host>.<domain>. The app's hosts are its routes' hosts."),
  path: routePathSchema.optional().describe("A path prefix: the route answers below it, and beats its host's route without one."),
  service: serviceNameSchema.describe("The compose service that answers it."),
  port: z.number().int().min(1).max(65535).describe("The port that service listens on, inside its container."),
  rate_limit: z
    .strictObject({
      average: z.number().int().positive().describe("Requests a client may send per period, on average."),
      period: periodSchema.describe("The period, such as 10s, 10m or 1h."),
      burst: z.number().int().positive().describe("Requests a client may send at once beyond the average."),
    })
    .optional()
    .describe("A rate limit on this route, per client address (Traefik's rateLimit)."),
  check: routePathSchema
    .optional()
    .describe("A path that answers 2xx or 3xx once the app is ready; a deploy waits for it. Without one, the route's own path must answer below 500."),
});

/** app.yml, at the root of an app's repository: the app contract. */
export const appManifestSchema = z.strictObject({
  name: appNameSchema.describe("The app's name, as in the server.yml entry."),
  compose: z.array(z.string()).describe("Compose files, relative to the app root, in order. No Traefik label, no platform network: routes say how the app is reached."),
  routes: z.array(routeSchema).optional().describe("How the app is reached: each route a host (and path) to a service's port. Read at the commit being deployed; a new host needs kayra apps."),
  secrets: z.array(z.string()).optional().describe("Secret keys; their values come from the fleet's secrets.yml, under app_secrets.<app>."),
  config: z.array(z.string()).optional().describe("Config keys; their values come from the fleet's apps/<app>.yml."),
});

