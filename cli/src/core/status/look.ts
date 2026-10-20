import { host, kayraVersion, sshDefaultPort, within, type KayraVersion } from "../fleet/brand.ts";
import type { Fleet, Server } from "../fleet/model.ts";
import { isMachine, type Look, type Machine, type Pending, type Reach, type Running, type Watched } from "./model.ts";
import type { Network, Tofu } from "./ports.ts";
import type { Result } from "../../lib/result.ts";
import { typed } from "../../lib/typed.ts";

/** The inventory names the address: hand-written at home, written by provision elsewhere. */
export const listed = (server: Server) =>
  server.inventory === undefined
    ? undefined
    : typed<Machine | undefined>({ kind: "found", address: server.inventory.host, from: "inventory" });

const provisioned = async (server: Server, tofu: Tofu) => {
  const dir = within(server.dir, "terraform");
  const state = await tofu.state(dir);
  if (!state.ok) return typed<Machine>({ kind: "unreadable", reason: state.error });
  if (state.value.length === 0) return typed<Machine>({ kind: "not-provisioned" });
  if (!state.value.some(isMachine)) return typed<Machine>({ kind: "no-machine" });
  const output = await tofu.output(dir, "server_ip");
  const address = output === undefined ? undefined : host(output);
  return typed<Machine>({ kind: "found", address: address?.ok === true ? address.value : undefined, from: "opentofu" });
};

export const sshPort = (server: Server) => server.inventory?.port ?? sshDefaultPort;

export const authUrl = (server: Server) => `https://auth.${server.domain}/`;

const pending: Pending = { kind: "pending" };

const skipped: Reach = { kind: "skipped" };

const notAsked: Running = { kind: "skipped" };

/** What the server's version file holds, as a version: none where setup never recorded one. */
const running = (read: Result<string, string>) => {
  if (!read.ok) return typed<Running>({ kind: "unreadable", reason: read.error });
  const text = read.value.trim();
  if (text === "") return typed<Running>({ kind: "unrecorded" });
  const version = kayraVersion(text);
  return version.ok ? typed<Running>({ kind: "recorded", version: version.value }) : typed<Running>({ kind: "unreadable", reason: version.error });
};

/** Which kayra set the server up, once SSH answered: its version file, over SSH as the inventory says. */
const recorded = (server: Server, network: Network, ssh: Reach) =>
  ssh.kind === "open" && server.inventory !== undefined && server.versionFile !== undefined
    ? network.read(server.inventory, server.versionFile).then(running)
    : Promise.resolve(notAsked);

const at =
  (index: number, change: Partial<Look>) =>
  (looks: readonly Look[]) =>
    typed<readonly Look[]>(looks.map((look, each) => (each === index ? { ...look, ...change } : look)));

/** What the network answers: SSH, then the version file once SSH is open; on a platform server, Authelia's health. */
const probes = (server: Server, index: number, machine: Promise<Machine>, network: Network) => {
  const ssh = machine.then((found) =>
    found.kind === "found" && found.address !== undefined ? network.connect(found.address, sshPort(server)) : skipped,
  );
  return typed<Watched["updates"]>([
    ssh.then((answer) => at(index, { ssh: answer })),
    ssh.then((answer) => recorded(server, network, answer)).then((answer) => at(index, { kayra: answer })),
    ...(server.kind === "platform" ? [network.get(`${authUrl(server)}api/health`).then((answer) => at(index, { https: answer }))] : []),
  ]);
};

/**
 * Every server as far as the fleet's files tell, and the answers still to
 * come, each an update to it: OpenTofu's state where no inventory names the
 * address, then a TCP connect to SSH and, once it is open, the version file
 * its setup wrote, over SSH; on platform servers HTTPS on auth.<domain>
 * (Authelia's health), all at once. Without a network (--offline), only
 * OpenTofu.
 */
export const look = (fleet: Fleet, pin: KayraVersion, tofu: Tofu, network: Network | undefined) =>
  fleet.servers.reduce<Watched>(
    (so, server, index) => {
      const known = listed(server);
      const machine = known === undefined ? provisioned(server, tofu) : Promise.resolve(known);
      const platform = server.kind === "platform";
      const updates = [
        ...(known === undefined ? [machine.then((answer) => at(index, { machine: answer }))] : []),
        ...(network === undefined ? [] : probes(server, index, machine, network)),
      ];
      const first: Look = {
        server,
        machine: known ?? pending,
        ssh: network === undefined ? skipped : pending,
        https: platform ? (network === undefined ? skipped : pending) : undefined,
        kayra: network === undefined ? notAsked : pending,
        pin,
      };
      return { initial: [...so.initial, first], updates: [...so.updates, ...updates] } as const;
    },
    { initial: [], updates: [] },
  );
