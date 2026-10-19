import { host, sshDefaultPort, within } from "../fleet/brand.ts";
import type { Fleet, Server } from "../fleet/model.ts";
import { isMachine, type Look, type Machine, type Pending, type Reach, type Watched } from "./model.ts";
import type { Network, Tofu } from "./ports.ts";
import { typed } from "../../typed.ts";

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

const at =
  (index: number, change: Partial<Look>) =>
  (looks: readonly Look[]) =>
    typed<readonly Look[]>(looks.map((look, each) => (each === index ? { ...look, ...change } : look)));

/**
 * Every server as far as the fleet's files tell, and the answers still to
 * come, each an update to it: OpenTofu's state where no inventory names the
 * address, then a TCP connect to SSH, and on platform servers HTTPS on
 * auth.<domain> (Authelia's health), all at once. Without a network
 * (--offline), only OpenTofu.
 */
export const look = (fleet: Fleet, tofu: Tofu, network: Network | undefined) =>
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
      return { initial: [...so.initial, first], updates: [...so.updates, ...updates] } as const;
    },
    { initial: [], updates: [] },
  );
