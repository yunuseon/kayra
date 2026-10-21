import type { Server } from "../fleet/model.ts";
import { partOf, run, type Plan, type Step } from "../plan/model.ts";
import { err, map, ok } from "../../lib/result.ts";
import { ansibleEnv, ansiblePath, appSubdomains, certs, collections, fleetEnv, fromMain, inventory, latestState, needing, reachable, script, sequence, terraform, withSecrets, withVariables, type Engine } from "./steps.ts";
import { apps } from "./apps.ts";
import { typed } from "../../lib/typed.ts";

export const provision = (engine: Engine, server: Server) =>
  ok<Plan>(
    partOf("provision", [
      fromMain(engine, server),
      ...(server.buildsVm ? [run("VM image and seed ISO", ["bash", script(engine, "home-image.sh"), server.name], fleetEnv(engine))] : []),
      ...(server.hasTerraform
        ? [
            latestState(engine, server),
            withVariables(run("OpenTofu init", ["tofu", terraform(server), "init", "-input=false"]), server),
            withVariables(run("OpenTofu apply", ["tofu", terraform(server), "apply", "-auto-approve"]), server),
          ]
        : []),
    ]),
  );

/** The playbook for the server's kind, as setup runs it; plan adds check mode. It records which kayra ran it (the kayra-version role). */
const hostPlaybook = (engine: Engine, server: Server, extra: readonly string[] = []) =>
  withSecrets(run(
    `Host layer · ${server.kind}.yml${extra.includes("--check") ? ", check mode" : ""}`,
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
      "-e",
      `kayra_version=${engine.version}`,
      ...extra,
    ],
    ansibleEnv(engine, {}),
  ), server);

/** The host layer: the playbook for the server's kind. */
export const setup = (engine: Engine, server: Server) =>
  ok<Plan>(
    partOf("setup", [
      fromMain(engine, server),
      // mkcert where Let's Encrypt cannot reach: test VMs, and home servers without DNS-01.
      ...(server.kind === "platform" && server.target !== "hetzner" && !server.usesAcmeDns
        ? [certs(engine, server.domain, [appSubdomains(engine, server), ...server.stackHosts])]
        : []),
      ...reachable(engine, server),
      collections(engine, {}),
      hostPlaybook(engine, server),
    ]),
  );

/**
 * What provision and setup would change, changing nothing: OpenTofu's plan and
 * the playbook in check mode, with diffs (files holding secrets say only that
 * they would change). From any checkout: it previews a branch against a server.
 */
export const preview = (engine: Engine, server: Server) =>
  ok<Plan>([
    ...reachable(engine, server),
    ...(server.hasTerraform
      ? [
          latestState(engine, server),
          withVariables(run("OpenTofu init", ["tofu", terraform(server), "init", "-input=false"]), server),
          withVariables(run("OpenTofu plan", ["tofu", terraform(server), "plan", "-input=false", "-lock=false"]), server),
        ]
      : []),
    collections(engine, {}),
    hostPlaybook(engine, server, ["--check", "--diff"]),
    { kind: "note", text: `kayra plan changed nothing on ${server.name}: the changed tasks above are what kayra setup would do.` },
  ]);

export const hosts = (engine: Engine, server: Server) =>
  ok<Plan>(
    partOf(
      "hosts",
      server.target === "multipass"
        ? [
            withVariables(needing(run("/etc/hosts", [
              "bash",
              script(engine, "setup-hosts.sh"),
              server.domain,
              { kind: "substitution", argv: ["tofu", terraform(server), "output", "-raw", "server_ip"], words: "one" },
              appSubdomains(engine, server),
            ]), [{ kind: "sudo" }]), server)
          ]
        : [{ kind: "note", text: `hosts: ${server.target} uses real DNS, nothing to do.` }],
    ),
  );

/**
 * Whether a platform server works as its users see it (scripts/local/verify.sh),
 * and runs the kayra this is; other kinds have nothing to check yet.
 */
const verifyStep = (engine: Engine, server: Server) => typed<Step>({
  ...run("Verify", ["bash", script(engine, "verify.sh"), server.name], { ...fleetEnv(engine), KAYRA_VERSION: engine.version }),
  part: "verify",
});

export const verify = (engine: Engine, server: Server) =>
  server.kind === "platform"
    ? ok<Plan>([verifyStep(engine, server)])
    : err(`'${server.name}' is of kind ${server.kind}: kayra verify checks platform servers only.`);

/** Host setup, then the apps; a platform server is verified at the end, so a deploy that leaves it broken fails. */
export const deploy = (engine: Engine, server: Server) =>
  map(sequence([setup(engine, server), apps(engine, server)]), (plan) =>
    server.kind === "platform" ? typed<Plan>([...plan, verifyStep(engine, server)]) : plan,
  );

export const up = (engine: Engine, server: Server) =>
  sequence([provision(engine, server), deploy(engine, server), hosts(engine, server)]);

export const down = (engine: Engine, server: Server) =>
  server.hasTerraform
    ? ok<Plan>([
        latestState(engine, server),
        ...(server.target === "hetzner"
          ? [
              {
                kind: "confirm",
                warning: `This destroys the Hetzner server '${server.name}' (${server.domain}) and everything on it.`,
                expect: server.name,
              } satisfies Step,
            ]
          : []),
        withVariables(run("OpenTofu destroy", ["tofu", terraform(server), "destroy", "-auto-approve"]), server),
      ])
    : err(`${server.name} has no terraform/: nothing here creates it, so nothing destroys it`);

/** Once, for a server we did not create: the deploy user, added as root. */
export const adopt = (engine: Engine, server: Server) =>
  ok<Plan>([
    fromMain(engine, server),
    collections(engine, {}),
    run(
      "Deploy user, added as root",
      ["ansible-playbook", "-i", inventory(server), ansiblePath(engine, "playbooks", "adopt.yml")],
      ansibleEnv(engine, {}),
    ),
  ]);
