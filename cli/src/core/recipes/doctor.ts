import type { Fleet, Server } from "../fleet/model.ts";
import type { Plan, Step } from "../plan/model.ts";
import { homeReach, onPath, type Engine } from "./steps.ts";
import { typed } from "../../lib/typed.ts";

type Tool = {
  readonly program: string;
  readonly install: string;
  readonly neededBy: (server: Server) => boolean;
};

const everyServer = () => true;

const tools: readonly Tool[] = [
  { program: "git", install: "brew install git", neededBy: everyServer },
  { program: "ssh", install: "macOS ships it", neededBy: everyServer },
  { program: "yq", install: "brew install yq", neededBy: everyServer },
  { program: "jq", install: "brew install jq", neededBy: everyServer },
  { program: "ansible-playbook", install: "brew install ansible", neededBy: everyServer },
  { program: "ansible-galaxy", install: "brew install ansible", neededBy: everyServer },
  { program: "sops", install: "brew install sops", neededBy: (server) => server.secrets.encrypted },
  { program: "age-plugin-se", install: "brew install age-plugin-se", neededBy: (server) => server.files.secrets.includes("recipient: age1se1") },
  { program: "tofu", install: "brew install opentofu", neededBy: (server) => server.hasTerraform },
  {
    program: "mkcert",
    install: "brew install mkcert && mkcert -install",
    neededBy: (server) => server.kind === "platform" && server.target !== "hetzner",
  },
  {
    program: "multipass",
    install: "brew install --cask multipass",
    neededBy: (server) => server.target === "multipass",
  },
  { program: "qemu-img", install: "brew install qemu", neededBy: (server) => server.buildsVm },
];

const toolChecks = (fleet: Fleet) =>
  Object.freeze(tools.flatMap((tool) => {
    const users = fleet.servers.filter(tool.neededBy).map((server) => server.name);
    return users.length === 0
      ? Object.freeze([])
      : Object.freeze([
          onPath(`${tool.program} (${users.length === fleet.servers.length ? "every server" : users.join(", ")})`, tool.program, tool.install, "continue"),
        ]);
  }));

// The key is only looked for, never used: opening secrets.yml may ask for Touch ID.
const keyChecks = (fleet: Fleet) =>
  Object.freeze(fleet.servers.flatMap((server) =>
    server.secrets.encrypted && server.secrets.key !== undefined
      ? Object.freeze([
          typed<Step>({
            kind: "check",
            label: `${server.name}'s age_key_file is here`,
            probe: { kind: "exits-zero", argv: ["test", "-f", server.secrets.key] },
            hint: `age_key_file in its server.yml is ${server.secrets.key}`,
            onFailure: "continue",
          }),
        ])
      : Object.freeze([]),
  ));

/** The apps' repositories are cloned on this Mac with the operator's own git credentials. */
const repoChecks = (fleet: Fleet) =>
  Object.freeze([...new Set(fleet.servers.flatMap((server) => Object.freeze(server.apps.map((app) => app.repo))))].map(
    (repo) =>
      ({
        kind: "check",
        label: `git can read ${repo}`,
        probe: { kind: "exits-zero", argv: ["sh", "-c", 'GIT_TERMINAL_PROMPT=0 git ls-remote "$1" HEAD', "sh", repo] },
        hint: "gh auth login && gh auth setup-git (or git credentials of your own for that host)",
        onFailure: "continue",
      }) as const satisfies Step,
  ));

const reachChecks = (fleet: Fleet, engine: Engine) =>
  Object.freeze(fleet.servers.filter((server) => server.target === "home").map((server) => homeReach(engine, server, "continue")));

/** Is this Mac ready to run every command on every server? Each check reports; none stops the others. */
export const doctor = (fleet: Fleet, engine: Engine) => typed<Plan>([
  ...toolChecks(fleet),
  ...keyChecks(fleet),
  ...repoChecks(fleet),
  ...reachChecks(fleet, engine),
]);
