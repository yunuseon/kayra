import { within, type AbsolutePath } from "../brand.ts";
import type { Fleet, Server } from "../fleet.ts";
import { capture } from "../interpret.ts";
import { err, ok, type Result } from "../../result.ts";
import { active, bad, link, muted, ok as fine, strong, warn, type Line, type Span } from "../present/line.ts";
import type { Update } from "../updates.ts";
import { fit, table } from "../present/text.ts";

/** Where a server's machine is, as this checkout knows it: its inventory.ini, else OpenTofu's state. */
export type Machine =
  | { readonly kind: "found"; readonly address: string | undefined; readonly from: "inventory" | "opentofu" }
  | { readonly kind: "not-provisioned" }
  /** OpenTofu's state holds something, but no machine: a storage box, a firewall left behind. */
  | { readonly kind: "no-machine" }
  | { readonly kind: "unreadable"; readonly reason: string };

/** How a port answered from here. */
export type Reach =
  | { readonly kind: "open"; readonly ms: number }
  | { readonly kind: "answered"; readonly status: number; readonly ms: number }
  /** Nothing listens: an on-demand SSH that is off. */
  | { readonly kind: "refused" }
  | { readonly kind: "no-answer" }
  | { readonly kind: "unreachable" }
  | { readonly kind: "unknown-host" }
  | { readonly kind: "bad-certificate"; readonly code: string }
  | { readonly kind: "failed"; readonly code: string }
  /** Nothing to ask: no address, or --offline. */
  | { readonly kind: "skipped" };

export type Pending = { readonly kind: "pending" };

/** A server as status sees it; a cell is pending until its answer is in. */
export type Look = {
  readonly server: Server;
  readonly machine: Machine | Pending;
  readonly ssh: Reach | Pending;
  /** auth.<domain>: platform servers only. */
  readonly https: Reach | Pending | undefined;
};

/** OpenTofu's state, as status reads it. */
export type Tofu = {
  /** The resources in a terraform/ directory's state, or why it could not be read. */
  readonly state: (dir: AbsolutePath) => Promise<Result<readonly string[], string>>;
  readonly output: (dir: AbsolutePath, name: string) => Promise<string | undefined>;
};

/** The network, as status probes it. */
export type Network = {
  /** A TCP connection to a port. */
  readonly connect: (host: string, port: number) => Promise<Reach>;
  readonly get: (url: string) => Promise<Reach>;
};

/** Why a connection failed, by Node's error code. */
export const failure = (code: string): Reach => {
  if (code === "ECONNREFUSED") return { kind: "refused" };
  if (code === "ETIMEDOUT") return { kind: "no-answer" };
  if (["EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN", "EADDRNOTAVAIL"].includes(code)) return { kind: "unreachable" };
  if (["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "EAI_NODATA"].includes(code)) return { kind: "unknown-host" };
  if (/CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/.test(code)) return { kind: "bad-certificate", code };
  return { kind: "failed", code };
};

/** Why tofu could not read the state, in a few words: the first line of its error. */
export const unreadable = (stderr: string): string => {
  if (stderr.includes("tofu init")) return "tofu init needed";
  const line = stderr
    .split("\n")
    .map((each) => each.replace(/^[│╷╵\s]+/, "").replace(/^Error:\s*/, "").trim())
    .find((each) => each !== "");
  return line ?? "tofu failed";
};

/** OpenTofu, read and never changed. */
export const opentofu: Tofu = {
  state: async (dir) => {
    const listed = await capture(["tofu", `-chdir=${dir}`, "state", "list", "-no-color"], "capture");
    return listed.code === 0 ? ok(listed.stdout.split("\n").filter((line) => line.trim() !== "")) : err(unreadable(listed.stderr));
  },
  output: async (dir, name) => {
    const value = await capture(["tofu", `-chdir=${dir}`, "output", "-raw", name], "capture");
    const text = value.stdout.trim();
    return value.code === 0 && text !== "" ? text : undefined;
  },
};

/** A machine kayra's modules create, by its resource type; a data source is none. */
export const isMachine = (resource: string): boolean => /(?:^|\.)(?<!data\.)(?:hcloud_server|multipass_instance)\.[^.]+$/.test(resource);

/** The inventory names the address: hand-written at home, written by provision elsewhere. */
const listed = (server: Server): Machine | undefined =>
  server.inventory === undefined
    ? undefined
    : { kind: "found", address: server.inventory.host === "" ? undefined : server.inventory.host, from: "inventory" };

const provisioned = async (server: Server, tofu: Tofu): Promise<Machine> => {
  const dir = within(server.dir, "terraform");
  const state = await tofu.state(dir);
  if (!state.ok) return { kind: "unreadable", reason: state.error };
  if (state.value.length === 0) return { kind: "not-provisioned" };
  if (!state.value.some(isMachine)) return { kind: "no-machine" };
  return { kind: "found", address: await tofu.output(dir, "server_ip"), from: "opentofu" };
};

const sshPort = (server: Server): number => Number(server.inventory?.port ?? "22");

const authUrl = (server: Server): string => `https://auth.${server.domain}/`;

const pending: Pending = { kind: "pending" };
const skipped: Reach = { kind: "skipped" };

const at =
  (index: number, change: Partial<Look>): Update<readonly Look[]> =>
  (looks) =>
    looks.map((look, each) => (each === index ? { ...look, ...change } : look));

export type Watched = { readonly initial: readonly Look[]; readonly updates: readonly Promise<Update<readonly Look[]>>[] };

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

/** A spinner as wide as most answers, so the columns hardly move when they come. */
const waiting = (frame: string, width: number): Line => [active(frame), " ".repeat(width - 1)];

const machineCell = (machine: Machine | Pending, frame: string): Line => {
  switch (machine.kind) {
    case "pending":
      return waiting(frame, "255.255.255.255".length);
    case "found":
      return [machine.address ?? muted("unknown")];
    case "not-provisioned":
      return [muted("not provisioned")];
    case "no-machine":
      return [muted("no machine")];
    case "unreadable":
      return [bad("state unreadable")];
  }
};

const took = (ms: number): Span => muted(` ${String(ms)}ms`);

/** An answer, said the same way for both probes. */
const said = (reach: Reach | Pending, frame: string): Line => {
  switch (reach.kind) {
    case "pending":
      return waiting(frame, "open 99ms".length);
    case "skipped":
      return [muted("–")];
    case "no-answer":
      return [bad("no answer")];
    case "unreachable":
      return [bad("unreachable")];
    case "unknown-host":
      return [bad("unknown host")];
    case "bad-certificate":
      return [bad(reach.code === "CERT_HAS_EXPIRED" ? "cert expired" : reach.code === "ERR_TLS_CERT_ALTNAME_INVALID" ? "wrong cert" : "untrusted cert")];
    case "failed":
      return [bad(reach.code.toLowerCase())];
    case "refused":
      return [bad("refused")];
    case "open":
      return [fine("open"), took(reach.ms)];
    case "answered":
      return [(reach.status < 400 ? fine : reach.status < 500 ? warn : bad)(String(reach.status)), took(reach.ms)];
  }
};

const sshCell = (reach: Reach | Pending, frame: string): Line => (reach.kind === "refused" ? [warn("off")] : said(reach, frame));

const httpsCell = (reach: Reach | Pending, frame: string, url: string): Line =>
  said(reach, frame).map((span, index) => (index === 0 && typeof span !== "string" ? link(span.text, url, span.tone) : span));

const headings = ["SERVER", "KIND", "TARGET", "DOMAIN", "ADDRESS", "SSH", "HTTPS", "APPS"];
const probed = ["SSH", "HTTPS"];

const row = (look: Look, frame: string): readonly Line[] => {
  const { server } = look;
  return [
    [strong(server.name)],
    [server.kind],
    [server.target],
    [link(server.domain, `https://${server.domain}/`)],
    machineCell(look.machine, frame),
    sshCell(look.ssh, frame),
    look.https === undefined ? [] : httpsCell(look.https, frame, authUrl(server)),
    [server.apps.map((app) => app.name).join(", ")],
  ];
};

/** How the table is drawn: the spinner's frame for what is pending, the columns there are, the probes' columns or not. */
export type Drawing = { readonly frame: string; readonly room: number; readonly offline: boolean };

/** Every server in a table, then what could not be read; --offline drops the probes' columns. */
export const statusView = (looks: readonly Look[], drawing: Drawing): readonly Line[] => {
  const shown = headings.flatMap((heading, index) => (drawing.offline && probed.includes(heading) ? [] : [index]));
  const rows = [headings.map((heading) => [muted(heading)]), ...looks.map((look) => row(look, drawing.frame))].map((cells) =>
    shown.map((index) => cells[index] ?? []),
  );
  const notes = looks.flatMap((look): readonly Line[] =>
    look.machine.kind === "unreadable"
      ? [
          ["  ", bad("✗"), " ", strong(look.server.name), `: OpenTofu's state could not be read: ${look.machine.reason}`],
          ...(look.machine.reason === "tofu init needed"
            ? [["    ", active("→"), " ", `tofu -chdir=servers/${look.server.name}/terraform init`]]
            : []),
        ]
      : [],
  );
  return [...table(fit(rows, drawing.room, [shown.length - 1, shown.indexOf(3)])), ...(notes.length === 0 ? [] : [[], ...notes])];
};

const ms = (reach: Reach | Pending): number | null => ("ms" in reach ? reach.ms : null);
const error = (reach: Reach | Pending): string | null => ("code" in reach ? reach.code : null);

/** `kayra status --json`: the shape cli.md documents. */
export const statusJson = (looks: readonly Look[]) => ({
  servers: looks.map(({ server, machine, ssh, https }) => ({
    name: server.name,
    kind: server.kind,
    target: server.target,
    domain: server.domain,
    apps: server.apps.map((app) => app.name),
    machine: {
      state: machine.kind,
      address: machine.kind === "found" ? (machine.address ?? null) : null,
      from: machine.kind === "found" ? machine.from : null,
      reason: machine.kind === "unreadable" ? machine.reason : null,
    },
    ssh: { port: sshPort(server), state: ssh.kind, ms: ms(ssh), error: error(ssh) },
    https:
      https === undefined
        ? null
        : {
            url: `${authUrl(server)}api/health`,
            state: https.kind,
            status: https.kind === "answered" ? https.status : null,
            ms: ms(https),
            error: error(https),
          },
  })),
});
