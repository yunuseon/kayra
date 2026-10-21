import { type FleetRoot, type KayraRoot, type KayraVersion, within } from "../fleet/brand.ts";
import type { Server } from "../fleet/model.ts";
import { run, type Arg, type Env, type Need, type Plan, type RunStep, type Step, type Substitution } from "../plan/model.ts";
import { all, map, type Result } from "../../lib/result.ts";
import { typed } from "../../lib/typed.ts";

/** What every command works with besides the server: the engine's files and version, and the fleet's files. */
export type Engine = { readonly kayra: KayraRoot; readonly fleet: FleetRoot; readonly version: KayraVersion };

/** The local scripts that read the fleet's files find them here, not beside themselves. */
export const fleetEnv = ({ fleet }: Engine) => typed<Env>({ FLEET_ROOT: fleet });

export const script = ({ kayra }: Engine, name: string) => within(kayra, "scripts", "local", name);

export const ansiblePath = ({ kayra }: Engine, ...segments: readonly string[]) =>
  within(kayra, "ansible", ...segments);

export const inventory = (server: Server) => within(server.dir, "inventory.ini");

export const terraform = (server: Server) => `-chdir=${within(server.dir, "terraform")}`;

/** secrets.yml opened for a step: for Ansible as a file (KAYRA_SECRETS), for OpenTofu as its variables. */
export const secretsFor = (server: Server, use: "ansible" | "opentofu") =>
  typed<Need>({ kind: "secrets", server: server.name, file: server.secrets.file, key: server.secrets.key, encrypted: server.secrets.encrypted, for: use });

export const needing = (step: RunStep, needs: readonly Need[]) => typed<RunStep>({ ...step, needs: [...(step.needs ?? []), ...needs] });

/** A step that reads the server's secrets.yml: Ansible's playbooks load it from KAYRA_SECRETS. */
export const withSecrets = (step: RunStep, server: Server) => needing(step, [secretsFor(server, "ansible")]);

/** An OpenTofu step: its variables from secrets.yml's terraform mapping (the state's passphrase among them). */
export const withVariables = (step: RunStep, server: Server) => needing(step, [secretsFor(server, "opentofu")]);

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
