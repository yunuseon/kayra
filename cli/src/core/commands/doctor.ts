import { within, type KayraRoot } from "../brand.ts";
import type { Fleet, Server } from "../fleet.ts";
import type { Plan, Step } from "../plan.ts";

type Tool = {
  readonly program: string;
  readonly install: string;
  readonly neededBy: (server: Server) => boolean;
};

const everyServer = (): boolean => true;

const tools: readonly Tool[] = [
  { program: "git", install: "brew install git", neededBy: everyServer },
  { program: "ssh", install: "macOS ships it", neededBy: everyServer },
  { program: "yq", install: "brew install yq", neededBy: everyServer },
  { program: "jq", install: "brew install jq", neededBy: everyServer },
  { program: "ansible-playbook", install: "brew install ansible", neededBy: everyServer },
  { program: "ansible-galaxy", install: "brew install ansible", neededBy: everyServer },
  { program: "ansible-vault", install: "brew install ansible", neededBy: (server) => server.vault.kind !== "none" },
  { program: "tofu", install: "brew install opentofu", neededBy: (server) => server.terraform },
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
  { program: "qemu-img", install: "brew install qemu", neededBy: (server) => server.vm },
];

const toolChecks = (fleet: Fleet): readonly Step[] =>
  tools.flatMap((tool) => {
    const users = fleet.servers.filter(tool.neededBy).map((server) => server.name);
    return users.length === 0
      ? []
      : [
          {
            kind: "check",
            label: `${tool.program} (${users.length === fleet.servers.length ? "every server" : users.join(", ")})`,
            probe: { kind: "on-path", program: tool.program },
            hint: tool.install,
            onFailure: "continue",
          } satisfies Step,
        ];
  });

// ansible-vault opens whole-file vaults only; values vaulted inline are opened by setup.
const vaultChecks = (fleet: Fleet): readonly Step[] =>
  fleet.servers.flatMap((server) =>
    server.vault.kind === "file" && server.secretsVaulted
      ? [
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
        ]
      : [],
  );

/** The apps' repositories are cloned on this Mac with the operator's own git credentials. */
const repoChecks = (fleet: Fleet): readonly Step[] =>
  [...new Set(fleet.servers.flatMap((server) => server.apps.map((app) => app.repo)))].map(
    (repo) =>
      ({
        kind: "check",
        label: `git can read ${repo}`,
        probe: { kind: "exits-zero", argv: ["sh", "-c", 'GIT_TERMINAL_PROMPT=0 git ls-remote "$1" HEAD', "sh", repo] },
        hint: "gh auth login && gh auth setup-git (or git credentials of your own for that host)",
        onFailure: "continue",
      }) satisfies Step,
  );

const reachChecks = (fleet: Fleet, kayra: KayraRoot): readonly Step[] =>
  fleet.servers
    .filter((server) => server.target === "home")
    .map(
      (server) =>
        ({
          kind: "check",
          label: `${server.name} answers over SSH`,
          probe: {
            kind: "exits-zero",
            argv: ["bash", within(kayra, "scripts", "local", "home-reach.sh"), server.name, server.kind],
            env: { FLEET_ROOT: fleet.root },
          },
          onFailure: "continue",
        }) satisfies Step,
    );

/** Is this Mac ready to run every command on every server? Each check reports; none stops the others. */
export const doctor = (fleet: Fleet, kayra: KayraRoot): Plan => [
  ...toolChecks(fleet),
  ...vaultChecks(fleet),
  ...repoChecks(fleet),
  ...reachChecks(fleet, kayra),
];
