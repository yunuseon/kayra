import { host, within, sshDefaultPort, type Port } from "../fleet/brand.ts";
import type { Fleet, Server } from "../fleet/model.ts";
import type { Update } from "./updates.ts";
import { isMachine, type Look, type Machine, type Pending, type Reach, type Watched } from "./model.ts";
import type { Network, Tofu } from "./ports.ts";

/** The inventory names the address: hand-written at home, written by provision elsewhere. */
export const listed = (server: Server): Machine | undefined =>
  server.inventory === undefined
    ? undefined
    : { kind: "found", address: server.inventory.host === "" ? undefined : server.inventory.host, from: "inventory" };

const provisioned = async (server: Server, tofu: Tofu): Promise<Machine> => {
  const dir = within(server.dir, "terraform");
  const state = await tofu.state(dir);
  if (!state.ok) return { kind: "unreadable", reason: state.error };
  if (state.value.length === 0) return { kind: "not-provisioned" };
  if (!state.value.some(isMachine)) return { kind: "no-machine" };
  const output = await tofu.output(dir, "server_ip");
  const address = output === undefined ? undefined : host(output);
  return { kind: "found", address: address?.ok === true ? address.value : undefined, from: "opentofu" };
};

export const sshPort = (server: Server): Port => server.inventory?.port ?? sshDefaultPort;

export const authUrl = (server: Server): string => `https://auth.${server.domain}/`;

const pending: Pending = { kind: "pending" };

const skipped: Reach = { kind: "skipped" };

const at =
  (index: number, change: Partial<Look>): Update<readonly Look[]> =>
  (looks) =>
    looks.map((look, each) => (each === index ? { ...look, ...change } : look));

/**
 * Every server as far as the fleet's files tell, and the answers still to
 * come, each an update to it: OpenTofu's state where no inventory names the
 * address, then a TCP connect to SSH, and on platform servers HTTPS on
 * auth.<domain> (Authelia's health), all at once. Without a network
 * (--offline), only OpenTofu.
 */
export const look = (fleet: Fleet, tofu: Tofu, network: Network | undefined): Watched =>
  fleet.servers.reduce<Watched>(
    (so, server, index) => {
      const known = listed(server);
      const machine = known === undefined ? provisioned(server, tofu) : Promise.resolve(known);
      const platform = server.kind === "platform";
      const updates = [
        ...(known === undefined ? [machine.then((answer) => at(index, { machine: answer }))] : []),
        ...(network === undefined
          ? []
          : [
              machine
                .then((found) =>
                  found.kind === "found" && found.address !== undefined ? network.connect(found.address, sshPort(server)) : skipped,
                )
                .then((answer) => at(index, { ssh: answer })),
              ...(platform ? [network.get(`${authUrl(server)}api/health`).then((answer) => at(index, { https: answer }))] : []),
            ]),
      ];
      const first: Look = {
        server,
        machine: known ?? pending,
        ssh: network === undefined ? skipped : pending,
        https: platform ? (network === undefined ? skipped : pending) : undefined,
      };
      return { initial: [...so.initial, first], updates: [...so.updates, ...updates] };
    },
    { initial: [], updates: [] },
  );
