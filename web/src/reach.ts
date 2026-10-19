import type { ReachState, Status, Tone } from "../../cli/src/clients/api/contract.gen.ts";
import { typed } from "./typed.ts";

export type Server = Status["servers"][number];

/** A cell of the status: what it says, and in which tone; `waiting` while its answer is still coming. */
export type Cell = { readonly text: string; readonly tone: Tone | "waiting"; readonly title?: string };

const ms = (value: number | null) => (value === null ? "" : ` · ${String(value)} ms`);

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

export const machine = (server: Server) => {
  const { state, address, reason } = server.machine;
  switch (state) {
    case "pending":
      return typed<Cell>({ text: "asking OpenTofu", tone: "waiting" });
    case "found":
      return typed<Cell>({ text: address ?? "an address OpenTofu does not give", tone: address === null ? "warn" : "strong" });
    case "not-provisioned":
      return typed<Cell>({ text: "not provisioned", tone: "muted" });
    case "no-machine":
      return typed<Cell>({ text: "no machine in its state", tone: "muted" });
    case "unreadable":
      return typed<Cell>({ text: "state unreadable", tone: "bad", ...(reason === null ? {} : { title: reason }) });
  }
};

export const ssh = (server: Server) => {
  const { state, error } = server.ssh;
  switch (state) {
    case "pending":
      return typed<Cell>({ text: "connecting", tone: "waiting" });
    case "open":
      return typed<Cell>({ text: `port ${String(server.ssh.port)} open${ms(server.ssh.ms)}`, tone: "ok" });
    case "refused":
      return typed<Cell>({ text: "off (refused)", tone: "warn", title: "Nothing listens: SSH may be on only on demand." });
    case "skipped":
      return typed<Cell>({ text: "not asked", tone: "muted" });
    case "answered":
    case "no-answer":
    case "unreachable":
    case "unknown-host":
    case "bad-certificate":
    case "failed":
      return typed<Cell>({ text: failed[state], tone: "bad", ...(error === null ? {} : { title: error }) });
  }
};

/** Its login (Authelia's health), on a platform server; nothing to ask elsewhere. */
export const login = (server: Server) => {
  const { https } = server;
  if (https === null) return undefined;
  switch (https.state) {
    case "pending":
      return typed<Cell | undefined>({ text: "asking", tone: "waiting" });
    case "answered":
      return typed<Cell | undefined>({
        text: `HTTP ${String(https.status ?? "?")}${ms(https.ms)}`,
        tone: https.status !== null && https.status < 400 ? "ok" : "bad",
      });
    case "skipped":
      return typed<Cell | undefined>({ text: "not asked", tone: "muted" });
    case "open":
    case "refused":
    case "no-answer":
    case "unreachable":
    case "unknown-host":
    case "bad-certificate":
    case "failed":
      return typed<Cell | undefined>({ text: failed[https.state], tone: "bad", ...(https.error === null ? {} : { title: https.error }) });
  }
};

/** One word for a server at a glance: up when everything it was asked answered well. */
export const health = (server: Server | undefined) => {
  if (server === undefined) return typed<Tone | "waiting">("waiting");
  const cells = [machine(server), ssh(server), login(server)].flatMap((cell) => (cell === undefined ? Object.freeze([]) : Object.freeze([cell.tone])));
  if (cells.includes("waiting")) return typed<Tone | "waiting">("waiting");
  if (cells.includes("bad")) return typed<Tone | "waiting">("bad");
  if (cells.includes("warn")) return typed<Tone | "waiting">("warn");
  return cells.includes("ok") ? typed<Tone | "waiting">("ok") : typed<Tone | "waiting">("muted");
};
