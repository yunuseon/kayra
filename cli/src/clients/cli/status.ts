import { active, bad, ok as fine, link, muted, pointing, strong, warn, type Line, type Span } from "../../core/text/spans.ts";
import { fit, table } from "./text.ts";
import type { Look, Machine, Pending, Reach } from "../../core/status/model.ts";
import { authUrl } from "../../core/status/look.ts";

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
            ? [pointing("    ", `tofu -chdir=servers/${look.server.name}/terraform init`)]
            : []),
        ]
      : [],
  );
  return [...table(fit(rows, drawing.room, [shown.length - 1, shown.indexOf(3)])), ...(notes.length === 0 ? [] : [[], ...notes])];
};
