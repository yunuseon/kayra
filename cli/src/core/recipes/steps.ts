import { type FleetRoot, type KayraRoot, within } from "../fleet/brand.ts";
import type { Server } from "../fleet/model.ts";
import { run, type Arg, type Env, type Need, type Plan, type RunStep, type Step, type Substitution } from "../plan/model.ts";
import { all, map, type Result } from "../../result.ts";
import { typed } from "../../typed.ts";

/** What every command works with besides the server: the engine's files and the fleet's. */
export type Engine = { readonly kayra: KayraRoot; readonly fleet: FleetRoot };

/** The local scripts that read the fleet's files find them here, not beside themselves. */
export const fleetEnv = ({ fleet }: Engine) => typed<Env>({ FLEET_ROOT: fleet });

export const script = ({ kayra }: Engine, name: string) => within(kayra, "scripts", "local", name);

export const ansiblePath = ({ kayra }: Engine, ...segments: readonly string[]) =>
  within(kayra, "ansible", ...segments);

export const inventory = (server: Server) => within(server.dir, "inventory.ini");

export const terraform = (server: Server) => `-chdir=${within(server.dir, "terraform")}`;

/** What a step needs to open a server's vault: Ansible's environment, and what kayra must ask. */
type VaultAccess = { readonly env: Env; readonly needs: readonly Need[] };

/**
 * How Ansible gets the vault password: from the server's password file, or
 * from kayra, which asks the operator once per run (Need "vault").
 */
export const vault = (server: Server) => {
  switch (server.vault.kind) {
    case "file":
      return typed<VaultAccess>({ env: { ANSIBLE_VAULT_PASSWORD_FILE: server.vault.file }, needs: [] });
    case "ask":
      return typed<VaultAccess>({ env: {}, needs: [{ kind: "vault", server: server.name }] });
    case "none":
      return typed<VaultAccess>({ env: {}, needs: [] });
  }
};

export const needing = (step: RunStep, needs: readonly Need[]) => typed<RunStep>({ ...step, needs });

/** The vault's environment, and its need where kayra must ask for the password. */
export const vaulted = (step: RunStep, server: Server) => {
  const { env, needs } = vault(server);
  return typed<RunStep>({ ...step, env: { ...env, ...step.env }, ...(needs.length === 0 ? {} : { needs }) });
};

export const ansibleEnv = (engine: Engine, env: Env) => typed<Env>({ ...env, ANSIBLE_CONFIG: ansiblePath(engine, "ansible.cfg") });

/** --verbose: every playbook prints Ansible's own output, with -v, instead of kayra's summary of it (ansible.cfg's stdout_callback). */
export const verbose = (plan: Plan) =>
  typed<Plan>(
    plan.map((step) =>
      step.kind === "run" && step.argv[0] === "ansible-playbook"
        ? typed<Step>({ ...step, argv: ["ansible-playbook", "-v", ...step.argv.slice(1)], env: { ...step.env, ANSIBLE_STDOUT_CALLBACK: "default" } })
        : step,
    ),
  );

/** Real servers change only from main as merged; a multipass one from anything. */
export const fromMain = (engine: Engine, server: Server) => typed<Step>({
  kind: "check",
  label: `${server.name} may be changed from this checkout`,
  probe: { kind: "exits-zero", argv: ["bash", script(engine, "require-main.sh"), server.name], env: fleetEnv(engine) },
  onFailure: "stop",
});

/** OpenTofu only on the newest committed state: none waiting on an unmerged branch. */
export const latestState = (engine: Engine, server: Server) => typed<Step>({
  kind: "check",
  label: `${server.name}'s OpenTofu state is the newest`,
  probe: { kind: "exits-zero", argv: ["bash", script(engine, "require-latest-state.sh"), within(server.dir, "terraform")] },
  onFailure: "stop",
});

/** Before Ansible's UNREACHABLE: why a home machine cannot be reached. */
export const reachable = (engine: Engine, server: Server) =>
  typed<readonly Step[]>(server.target === "home" ? [homeReach(engine, server, "stop")] : []);

/** Whether a home machine answers over SSH, and if not, why (scripts/local/home-reach.sh). */
export const homeReach = (engine: Engine, server: Server, onFailure: "stop" | "continue") => typed<Step>({
  kind: "check",
  label: `${server.name} answers over SSH`,
  probe: { kind: "exits-zero", argv: ["bash", script(engine, "home-reach.sh"), server.name, server.kind], env: fleetEnv(engine) },
  onFailure,
});

/** Whether a program is on PATH, and how to install it where it is not. */
export const onPath = (label: string, program: string, hint: string, onFailure: "stop" | "continue") => typed<Step>({
  kind: "check",
  label,
  probe: { kind: "on-path", program },
  hint,
  onFailure,
});

/** The pinned Ansible collections; a no-op once installed. */
export const collections = (engine: Engine, env: Env) => typed<Step>({
  kind: "run",
  title: "Ansible collections",
  argv: ["ansible-galaxy", "collection", "install", "-r", ansiblePath(engine, "requirements.yml")],
  env,
  stdout: "discard",
});

export const appSubdomains = (engine: Engine, server: Server) => typed<Substitution>({
  kind: "substitution",
  argv: ["bash", script(engine, "app-manifests.sh"), "--subdomains", server.name],
  words: "many",
  env: fleetEnv(engine),
});

export const certs = (engine: Engine, domain: string, subdomains: readonly Arg[]) =>
  run("mkcert certificates", ["bash", script(engine, "certs.sh"), domain, within(engine.fleet, ".cache", "certs"), ...subdomains]);

export const sequence = (plans: readonly Result<Plan, string>[]) =>
  map(all(plans), (each) => Object.freeze(each.flat()));
