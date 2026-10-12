import { within } from "../brand.ts";
import type { Fleet, Server } from "../fleet.ts";
import { capture } from "../interpret.ts";

/** What OpenTofu's state says of a server: nothing, a machine (and its address, if it has an output for it), or that it could not be read. */
export type Machine =
  | { readonly kind: "none" }
  | { readonly kind: "provisioned"; readonly ip: string | undefined }
  | { readonly kind: "unreadable"; readonly reason: string };

const describe = (machine: Machine): string => {
  switch (machine.kind) {
    case "none":
      return "not provisioned";
    case "provisioned":
      return `provisioned (${machine.ip ?? "?"})`;
    case "unreadable":
      return `state unreadable: ${machine.reason}`;
  }
};

export const statusLine = (server: Server, machine: Machine): string =>
  [
    server.name.padEnd(10),
    `kind=${server.kind.padEnd(9)} target=${server.target.padEnd(10)}`,
    `domain=${server.domain.padEnd(24)}`,
    `apps=${server.apps.map((app) => app.name).join(",").padEnd(10)}`,
    describe(machine),
  ].join("  ");

/** Why tofu could not read the state, in a few words: the first line of its error. */
export const unreadable = (stderr: string): string => {
  if (stderr.includes("tofu init")) return "tofu init needed";
  const line = stderr
    .split("\n")
    .map((each) => each.replace(/^[│╷╵\s]+/, "").replace(/^Error:\s*/, "").trim())
    .find((each) => each !== "");
  return line ?? "tofu failed";
};

const machine = async (server: Server): Promise<Machine> => {
  if (!server.terraform) return { kind: "none" };
  const chdir = `-chdir=${within(server.dir, "terraform")}`;
  const state = await capture(["tofu", chdir, "state", "list", "-no-color"], "capture");
  if (state.code !== 0) return { kind: "unreadable", reason: unreadable(state.stderr) };
  if (state.stdout.trim() === "") return { kind: "none" };
  const ip = await capture(["tofu", chdir, "output", "-raw", "server_ip"], "capture");
  return { kind: "provisioned", ip: ip.code === 0 ? ip.stdout.replace(/\n+$/, "") : undefined };
};

/** Every server and whether a machine exists for it. Reads state, changes nothing. */
export const status = async (fleet: Fleet): Promise<readonly string[]> =>
  Promise.all(fleet.servers.map(async (server) => statusLine(server, await machine(server))));
