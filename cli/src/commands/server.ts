import {
  within,
  type AbsolutePath,
  type AppName,
  type Domain,
  type FleetRoot,
  type KayraRoot,
  type Subdomain,
} from "../brand.ts";
import type { Server } from "../fleet.ts";
import { run, type Arg, type Env, type Plan, type Query, type Step } from "../plan.ts";
import { all, err, map, ok, type Result } from "../result.ts";

/** What every command works with besides the server: the engine's files and the fleet's. */
export type Engine = { readonly kayra: KayraRoot; readonly fleet: FleetRoot };

/** The local scripts that read the fleet's files find them here, not beside themselves. */
const fleetEnv = ({ fleet }: Engine): Env => ({ FLEET_ROOT: fleet });

const script = ({ kayra }: Engine, name: string): AbsolutePath => within(kayra, "scripts", "local", name);
const ansiblePath = ({ kayra }: Engine, ...segments: readonly string[]): AbsolutePath =>
  within(kayra, "ansible", ...segments);
const inventory = (server: Server): AbsolutePath => within(server.dir, "inventory.ini");
const terraform = (server: Server): string => `-chdir=${within(server.dir, "terraform")}`;

/** How Ansible gets the vault password: from a file, or by asking. */
const vaultEnv = (server: Server): Env => {
  switch (server.vault.kind) {
    case "file":
      return { ANSIBLE_VAULT_PASSWORD_FILE: server.vault.file };
    case "ask":
      return { ANSIBLE_ASK_VAULT_PASS: "True" };
    case "none":
      return {};
  }
};

const ansibleEnv = (engine: Engine, env: Env): Env => ({ ...env, ANSIBLE_CONFIG: ansiblePath(engine, "ansible.cfg") });

/** Real servers change only from main as merged; a multipass one from anything. */
const fromMain = (engine: Engine, server: Server): Step => ({
  kind: "check",
  label: `${server.name} may be changed from this checkout`,
  probe: { kind: "exits-zero", argv: ["bash", script(engine, "require-main.sh"), server.name], env: fleetEnv(engine) },
  onFailure: "stop",
});

/** OpenTofu only on the newest committed state: none waiting on an unmerged branch. */
const latestState = (engine: Engine, server: Server): Step => ({
  kind: "check",
  label: `${server.name}'s OpenTofu state is the newest`,
  probe: { kind: "exits-zero", argv: ["bash", script(engine, "require-latest-state.sh"), within(server.dir, "terraform")] },
  onFailure: "stop",
});

/** Before Ansible's UNREACHABLE: why a home machine cannot be reached. */
const reachable = (engine: Engine, server: Server): readonly Step[] =>
  server.target === "home"
    ? [
        {
          kind: "check",
          label: `${server.name} answers over SSH`,
          probe: {
            kind: "exits-zero",
            argv: ["bash", script(engine, "home-reach.sh"), server.name, server.kind],
            env: fleetEnv(engine),
          },
          onFailure: "stop",
        },
      ]
    : [];

/** The pinned Ansible collections; a no-op once installed. */
const collections = (engine: Engine, env: Env): Step => ({
  kind: "run",
  argv: ["ansible-galaxy", "collection", "install", "-r", ansiblePath(engine, "requirements.yml")],
  env,
  stdout: "discard",
});

const appSubdomains = (engine: Engine, server: Server): Query => ({
  kind: "query",
  argv: ["bash", script(engine, "app-manifests.sh"), "--subdomains", server.name],
  words: "many",
  env: fleetEnv(engine),
});

const certs = (engine: Engine, domain: string, subdomains: readonly Arg[]): Step =>
  run(["bash", script(engine, "certs.sh"), domain, within(engine.fleet, ".cache", "certs"), ...subdomains]);

export const provision = (engine: Engine, server: Server): Result<Plan, string> =>
  ok([
    fromMain(engine, server),
    ...(server.vm ? [run(["bash", script(engine, "home-image.sh"), server.name], fleetEnv(engine))] : []),
    ...(server.terraform
      ? [
          latestState(engine, server),
          run(["tofu", terraform(server), "init", "-input=false"]),
          run(["tofu", terraform(server), "apply", "-auto-approve"]),
        ]
      : []),
  ]);

/** The playbook for the server's kind, as setup runs it; plan adds check mode. */
const hostPlaybook = (engine: Engine, server: Server, extra: readonly string[] = []): Step =>
  run(
    [
      "ansible-playbook",
      "-i",
      inventory(server),
      ansiblePath(engine, "playbooks", `${server.kind}.yml`),
      "-e",
      `server=${server.name}`,
      "-e",
      `server_dir=${server.dir}`,
      "-e",
      `domain=${server.domain}`,
      "-e",
      `target=${server.target}`,
      ...extra,
    ],
    ansibleEnv(engine, vaultEnv(server)),
  );

/** The host layer: the playbook for the server's kind. */
export const setup = (engine: Engine, server: Server): Result<Plan, string> =>
  ok([
    fromMain(engine, server),
    // mkcert where Let's Encrypt cannot reach: test VMs, and home servers without DNS-01.
    ...(server.kind === "platform" && server.target !== "hetzner" && !server.acmeDns
      ? [certs(engine, server.domain, [appSubdomains(engine, server), ...server.stackHosts])]
      : []),
    ...reachable(engine, server),
    collections(engine, vaultEnv(server)),
    hostPlaybook(engine, server),
  ]);

/**
 * What provision and setup would change, changing nothing: OpenTofu's plan and
 * the playbook in check mode, with diffs (files holding secrets say only that
 * they would change). From any checkout: it previews a branch against a server.
 */
export const preview = (engine: Engine, server: Server): Result<Plan, string> =>
  ok([
    ...reachable(engine, server),
    ...(server.terraform
      ? [
          latestState(engine, server),
          run(["tofu", terraform(server), "init", "-input=false"]),
          run(["tofu", terraform(server), "plan", "-input=false", "-lock=false"]),
        ]
      : []),
    collections(engine, vaultEnv(server)),
    hostPlaybook(engine, server, ["--check", "--diff"]),
    { kind: "note", text: `kayra plan changed nothing on ${server.name}: the changed tasks above are what kayra setup would do.` },
  ]);

/** Register every app in server.yml, then remove the rest (their data kept). */
export const apps = (engine: Engine, server: Server): Result<Plan, string> => {
  const env = vaultEnv(server);
  const playbook = (name: string, ...extra: readonly string[]): Step =>
    run(["ansible-playbook", "-i", inventory(server), ansiblePath(engine, "playbooks", name), ...extra], ansibleEnv(engine, env));
  return ok([
    fromMain(engine, server),
    ...(server.kind === "platform"
      ? [
          ...server.apps.flatMap((app) => [
            collections(engine, env),
            playbook(
              "app.yml",
              "-e",
              `server=${server.name}`,
              "-e",
              `server_dir=${server.dir}`,
              "-e",
              `domain=${server.domain}`,
              "-e",
              `{"app": ${app.entry}}`,
            ),
          ]),
          collections(engine, env),
          playbook("apps-prune.yml", "-e", `{"keep": ${JSON.stringify(server.apps.map((app) => app.name))}}`),
        ]
      : []),
  ]);
};

export const hosts = (engine: Engine, server: Server): Result<Plan, string> =>
  ok(
    server.target === "multipass"
      ? [
          run([
            "bash",
            script(engine, "setup-hosts.sh"),
            server.domain,
            { kind: "query", argv: ["tofu", terraform(server), "output", "-raw", "server_ip"], words: "one" },
            appSubdomains(engine, server),
          ]),
        ]
      : [{ kind: "note", text: `hosts: ${server.target} uses real DNS, nothing to do.` }],
  );

const sequence = (plans: readonly Result<Plan, string>[]): Result<Plan, string> =>
  map(all(plans), (each) => each.flat());

export const deploy = (engine: Engine, server: Server): Result<Plan, string> =>
  sequence([setup(engine, server), apps(engine, server)]);

export const up = (engine: Engine, server: Server): Result<Plan, string> =>
  sequence([provision(engine, server), deploy(engine, server), hosts(engine, server)]);

export const down = (engine: Engine, server: Server): Result<Plan, string> =>
  server.terraform
    ? ok([
        latestState(engine, server),
        ...(server.target === "hetzner"
          ? [
              {
                kind: "confirm",
                prompt: `This destroys the Hetzner server '${server.name}' (${server.domain}). Type the name to confirm: `,
                expect: server.name,
              } satisfies Step,
            ]
          : []),
        run(["tofu", terraform(server), "destroy", "-auto-approve"]),
      ])
    : err(`${server.name} has no terraform/: nothing here creates it, so nothing destroys it`);

/** Once, for a server we did not create: the deploy user, added as root. */
export const adopt = (engine: Engine, server: Server): Result<Plan, string> =>
  ok([
    fromMain(engine, server),
    collections(engine, {}),
    run(
      ["ansible-playbook", "-i", inventory(server), ansiblePath(engine, "playbooks", "adopt.yml")],
      ansibleEnv(engine, {}),
    ),
  ]);

/** A removed app's volumes: its data, irreversibly. */
export const appPurge = (engine: Engine, server: Server, app: AppName): Result<Plan, string> =>
  ok([
    fromMain(engine, server),
    run(
      [
        "ansible",
        "servers",
        "-i",
        inventory(server),
        "--become",
        "-m",
        "ansible.builtin.command",
        "-a",
        `/opt/platform/bin/app-purge ${app}`,
      ],
      ansibleEnv(engine, {}),
    ),
  ]);

/**
 * The restic-backup role's restore test: the latest backup, restored to a scratch dir and checked.
 * It runs on the server, detached; kayra follows its log over SSH. Stopping kayra stops only the
 * following, and running it again while a test runs follows that one instead of starting another.
 */
export const backupTest = (engine: Engine, server: Server): Result<Plan, string> => {
  if (server.backupDir === undefined) return err(`${server.name} has no restic_backup.dir in its vars.yml`);
  if (server.inventory === undefined) return err(`no inventory for '${server.name}' — provision it first.`);
  return ok([
    ...reachable(engine, server),
    run(
      [
        "ansible",
        "servers",
        "-i",
        inventory(server),
        "--become",
        "-e",
        `@${within(server.dir, "secrets.yml")}`,
        "-m",
        "ansible.builtin.command",
        "-a",
        `docker compose -f ${server.backupDir}/docker-compose.yml exec -d -T backup /etc/backup/restore-test.sh`,
      ],
      ansibleEnv(engine, vaultEnv(server)),
    ),
    { kind: "note", text: "Following the restore test. Ctrl-C stops following, not the test." },
    run([
      "ssh",
      "-p",
      server.inventory.port,
      "-i",
      server.inventory.key,
      "-o",
      "StrictHostKeyChecking=accept-new",
      `${server.inventory.user}@${server.inventory.host}`,
      "sh",
      `${server.backupDir}/follow-restore-test.sh`,
    ]),
  ]);
};

/** An interactive shell, or the remote command as ssh runs it (the remote shell reads it). */
export const ssh = (server: Server, remote: readonly string[]): Result<Plan, string> =>
  server.inventory === undefined
    ? err(`no inventory for '${server.name}' — provision it first.`)
    : ok([
        run([
          "ssh",
          "-p",
          server.inventory.port,
          "-i",
          server.inventory.key,
          "-o",
          "StrictHostKeyChecking=no",
          "-o",
          "UserKnownHostsFile=/dev/null",
          `${server.inventory.user}@${server.inventory.host}`,
          ...remote,
        ]),
      ]);

/** What `kayra app …` and `kayra job …` ask of a server: its deployer's ctl, over SSH. */
export type DeployerCommand =
  | { readonly kind: "runs" | "logs" | "deploy" | "rollback"; readonly app: AppName; readonly more: string | undefined }
  | { readonly kind: "job"; readonly job: "gc" | "renovate"; readonly noPrs: boolean };

const ctlArgs = (command: DeployerCommand): readonly string[] => {
  switch (command.kind) {
    case "job":
      return ["job", command.job, ...(command.noPrs ? ["--dry-run"] : [])];
    case "logs":
      return ["log", command.app, ...(command.more === undefined ? [] : [command.more])];
    case "runs":
    case "deploy":
    case "rollback":
      return [command.kind, command.app, ...(command.more === undefined ? [] : [command.more])];
  }
};

/** Inside the deployer container, as the deploy user (in the docker group): nothing here needs root. */
export const deployer = (server: Server, command: DeployerCommand): Result<Plan, string> =>
  server.kind === "platform"
    ? ssh(server, ["cd", "/opt/platform", "&&", "docker", "compose", "exec", "-T", "deployer", "kayra-deployer", "ctl", ...ctlArgs(command)])
    : err(`'${server.name}' is a ${server.kind} server: only platform servers run apps.`);

/** mkcert certs for a domain and its subdomains, for local dev and multipass. */
export const certsFor = (engine: Engine, domain: Domain, subdomains: readonly Subdomain[]): Result<Plan, string> =>
  ok([certs(engine, domain, subdomains)]);
