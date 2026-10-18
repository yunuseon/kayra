import type { ReachState, Status, Tone } from "../../cli/src/clients/api/contract.gen.ts";

export type Server = Status["servers"][number];

/** A cell of the status: what it says, and in which tone; `waiting` while its answer is still coming. */
export type Cell = { readonly text: string; readonly tone: Tone | "waiting"; readonly title?: string };

const ms = (value: number | null): string => (value === null ? "" : ` · ${String(value)} ms`);

/** A failed answer in words. */
const failed: Readonly<Record<ReachState, string>> = {
  pending: "asking",
  open: "open",
  answered: "answered",
  refused: "refused",
  "no-answer": "no answer",
  unreachable: "unreachable",
  "unknown-host": "unknown host",
  "bad-certificate": "bad certificate",
  failed: "failed",
  skipped: "not asked",
};

export const machine = (server: Server): Cell => {
  const { state, address, reason } = server.machine;
  switch (state) {
    case "pending":
      return { text: "asking OpenTofu", tone: "waiting" };
    case "found":
      return { text: address ?? "an address OpenTofu does not give", tone: address === null ? "warn" : "strong" };
    case "not-provisioned":
      return { text: "not provisioned", tone: "muted" };
    case "no-machine":
      return { text: "no machine in its state", tone: "muted" };
    case "unreadable":
      return { text: "state unreadable", tone: "bad", ...(reason === null ? {} : { title: reason }) };
  }
};

export const ssh = (server: Server): Cell => {
  const { state, error } = server.ssh;
  switch (state) {
    case "pending":
      return { text: "connecting", tone: "waiting" };
    case "open":
      return { text: `port ${String(server.ssh.port)} open${ms(server.ssh.ms)}`, tone: "ok" };
    case "refused":
      return { text: "off (refused)", tone: "warn", title: "Nothing listens: SSH may be on only on demand." };
    case "skipped":
      return { text: "not asked", tone: "muted" };
    case "answered":
    case "no-answer":
    case "unreachable":
    case "unknown-host":
    case "bad-certificate":
    case "failed":
      return { text: failed[state], tone: "bad", ...(error === null ? {} : { title: error }) };
  }
};

/** Its login (Authelia's health), on a platform server; nothing to ask elsewhere. */
export const login = (server: Server): Cell | undefined => {
  const { https } = server;
  if (https === null) return undefined;
  switch (https.state) {
    case "pending":
      return { text: "asking", tone: "waiting" };
    case "answered":
      return {
        text: `HTTP ${String(https.status ?? "?")}${ms(https.ms)}`,
        tone: https.status !== null && https.status < 400 ? "ok" : "bad",
      };
    case "skipped":
      return { text: "not asked", tone: "muted" };
    case "open":
    case "refused":
    case "no-answer":
    case "unreachable":
    case "unknown-host":
    case "bad-certificate":
    case "failed":
      return { text: failed[https.state], tone: "bad", ...(https.error === null ? {} : { title: https.error }) };
  }
};

/** One word for a server at a glance: up when everything it was asked answered well. */
export const health = (server: Server | undefined): Tone | "waiting" => {
  if (server === undefined) return "waiting";
  const cells = [machine(server), ssh(server), login(server)].flatMap((cell) => (cell === undefined ? [] : [cell.tone]));
  if (cells.includes("waiting")) return "waiting";
  if (cells.includes("bad")) return "bad";
  if (cells.includes("warn")) return "warn";
  return cells.includes("ok") ? "ok" : "muted";
};
