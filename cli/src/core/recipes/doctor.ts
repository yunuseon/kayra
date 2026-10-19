import { within, type KayraRoot } from "../fleet/brand.ts";
import type { Fleet, Server } from "../fleet/model.ts";
import type { Plan, Step } from "../plan/model.ts";
import { homeReach, onPath } from "./steps.ts";
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
  { program: "ansible-vault", install: "brew install ansible", neededBy: (server) => server.vault.kind !== "none" },
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

// ansible-vault opens whole-file vaults only; values vaulted inline are opened by setup.
const vaultChecks = (fleet: Fleet) =>
  Object.freeze(fleet.servers.flatMap((server) =>
    server.vault.kind === "file" && server.hasVaultedSecrets
      ? Object.freeze([
          {
            kind: "check",
            label: `vault password opens ${server.name}'s secrets.yml`,
            probe: {
              kind: "exits-zero",
              argv: ["ansible-vault", "view", "--vault-password-file", server.vault.file, within(server.dir, "secrets.yml")],
            },
            hint: `the password file is ${server.vault.file}`,
            onFailure: "continue",
          } satisfies Step,
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

const reachChecks = (fleet: Fleet, kayra: KayraRoot) =>
  Object.freeze(fleet.servers.filter((server) => server.target === "home").map((server) => homeReach({ kayra, fleet: fleet.root }, server, "continue")));

/** Is this Mac ready to run every command on every server? Each check reports; none stops the others. */
export const doctor = (fleet: Fleet, kayra: KayraRoot) => typed<Plan>([
  ...toolChecks(fleet),
  ...vaultChecks(fleet),
  ...repoChecks(fleet),
  ...reachChecks(fleet, kayra),
]);
