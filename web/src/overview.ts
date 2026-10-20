import type { RunState, RunSummary, ServerFacts } from "../../cli/src/clients/wire/contract.gen.ts";
import type { Draft } from "./operations.ts";
import { health, kayra, login, machine, ssh, type Cell, type Server } from "./reach.ts";
import type { Route } from "./router.ts";
import { typed } from "./typed.ts";

/** Runs, the newest first: their ids and start times sort by time. */
export const newest = (runs: readonly RunSummary[]) => Object.freeze(runs.toSorted((a, b) => b.started.localeCompare(a.started)));

/** A server's last `count` runs, oldest to newest, as the strip draws them. */
export const strip = (runs: readonly RunSummary[], server: string, count: number) =>
  Object.freeze(newest(runs).filter((run) => run.server === server).slice(0, count).toReversed().map((run) => run.state));

/** The strip in words, for whoever cannot see it. */
export const stripLabel = (states: readonly RunState[]) => {
  if (states.length === 0) return "No runs from here yet";
  const counts = typed<readonly RunState[]>(["passed", "failed", "interrupted", "declined", "running"]).flatMap((state) => {
    const count = states.filter((each) => each === state).length;
    return count === 0 ? Object.freeze([]) : Object.freeze([`${String(count)} ${state}`]);
  });
  return `Last ${String(states.length)} runs: ${counts.join(", ")}`;
};

/** The command that brings a server to the fleet's pin: deploy on a platform, setup elsewhere. */
export const primary = (facts: ServerFacts) => {
  if (facts.kind === "platform" && facts.commands.includes("deploy")) return typed<"deploy" | "setup" | undefined>("deploy");
  return facts.commands.includes("setup") ? typed<"deploy" | "setup" | undefined>("setup") : undefined;
};

/** What a note offers: a command's form, a page, or asking every server again. */
export type Remedy =
  | { readonly kind: "run"; readonly label: string; readonly draft: Draft }
  | { readonly kind: "go"; readonly label: string; readonly to: Route }
  | { readonly kind: "ask"; readonly label: string };

export type Note = { readonly tone: "bad" | "warn" | "active"; readonly title: string; readonly text: string; readonly remedies: readonly Remedy[] };

const said = (label: string, cell: Cell | undefined) => (cell?.tone === "bad" ? Object.freeze([`${label} ${cell.text}`]) : Object.freeze([]));

const reachNotes = (facts: ServerFacts, server: Server) => {
  const page = typed<Remedy>({ kind: "go", label: `open ${facts.name}`, to: { page: "server", server: facts.name } });
  const again = typed<Remedy>({ kind: "ask", label: "ask again" });
  const down =
    health(server) === "bad"
      ? [
          typed<Note>({
            tone: "bad",
            title: `${facts.name} does not answer`,
            text: [...said("address", machine(server)), ...said("ssh", ssh(server)), ...said("login", login(server))].join(" · "),
            remedies: [page, again],
          }),
        ]
      : [];
  const off =
    server.ssh.state === "refused"
      ? [
          typed<Note>({
            tone: "warn",
            title: `${facts.name}: SSH is off`,
            text: `Nothing listens on port ${String(server.ssh.port)}. If its SSH is on only on demand, switch it on, then ask again.`,
            remedies: [again, page],
          }),
        ]
      : [];
  const command = primary(facts);
  const behind =
    kayra(server).tone === "warn"
      ? [
          typed<Note>({
            tone: "warn",
            title: server.kayra.version === null ? `${facts.name} records no kayra version` : `${facts.name} runs kayra ${server.kayra.version}`,
            text: `This fleet pins ${server.kayra.pin}${command === undefined ? "." : `: ${command} records it.`}`,
            remedies:
              command === undefined
                ? [page]
                : [{ kind: "run", label: `${command} ${facts.name}`, draft: { name: command, input: { server: facts.name } } }, page],
          }),
        ]
      : [];
  return Object.freeze([...down, ...off, ...behind]);
};

/** What needs the operator, the worst first: servers that do not answer, last runs that failed, warnings, runs still going. */
export const attention = (servers: readonly ServerFacts[], seen: readonly Server[], runs: readonly RunSummary[]) => {
  const latest = newest(runs);
  const reached = servers.flatMap((facts) => {
    const server = seen.find((each) => each.name === facts.name);
    return server === undefined ? Object.freeze([]) : reachNotes(facts, server);
  });
  const failed = servers.flatMap((facts) => {
    const last = latest.find((run) => run.server === facts.name && run.state !== "running");
    return last?.state === "failed"
      ? Object.freeze([
          typed<Note>({
            tone: "bad",
            title: `${last.command} failed`,
            text: `The last run on ${facts.name} failed. Its log says where.`,
            remedies: [{ kind: "go", label: "open the run", to: { page: last.session ? "session" : "run", id: last.id } }],
          }),
        ])
      : Object.freeze([]);
  });
  const running = latest
    .filter((run) => run.state === "running")
    .map((run) =>
      typed<Note>({
        tone: "active",
        title: `running: ${run.command}`,
        text: run.session ? "An SSH session is open." : "Still going.",
        remedies: [{ kind: "go", label: run.session ? "open the session" : "follow it", to: { page: run.session ? "session" : "run", id: run.id } }],
      }),
    );
  return Object.freeze([...reached.filter((note) => note.tone === "bad"), ...failed, ...reached.filter((note) => note.tone !== "bad"), ...running]);
};
