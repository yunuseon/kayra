import { active, bad, ok as fine, type Line, link, muted, pointing, strong, warn } from "../../core/text/spans.ts";
import { fit, table } from "./text.ts";
import type { Look, Machine, Pending, Reach, Running } from "../../core/status/model.ts";
import type { KayraVersion } from "../../core/fleet/brand.ts";
import { authUrl } from "../../core/status/look.ts";
import { typed } from "../../lib/typed.ts";

/** A spinner as wide as most answers, so the columns hardly move when they come. */
const waiting = (frame: string, width: number) => typed<Line>([active(frame), " ".repeat(width - 1)]);

const machineCell = (machine: Machine | Pending, frame: string) => {
  switch (machine.kind) {
    case "pending":
      return waiting(frame, "255.255.255.255".length);
    case "found":
      return typed<Line>([machine.address ?? muted("unknown")]);
    case "not-provisioned":
      return typed<Line>([muted("not provisioned")]);
    case "no-machine":
      return typed<Line>([muted("no machine")]);
    case "unreadable":
      return typed<Line>([bad("state unreadable")]);
  }
};

const took = (ms: number) => muted(` ${String(ms)}ms`);

/** An answer, said the same way for both probes. */
const said = (reach: Reach | Pending, frame: string) => {
  switch (reach.kind) {
    case "pending":
      return waiting(frame, "open 99ms".length);
    case "skipped":
      return typed<Line>([muted("–")]);
    case "no-answer":
      return typed<Line>([bad("no answer")]);
    case "unreachable":
      return typed<Line>([bad("unreachable")]);
    case "unknown-host":
      return typed<Line>([bad("unknown host")]);
    case "bad-certificate":
      return typed<Line>([bad(reach.code === "CERT_HAS_EXPIRED" ? "cert expired" : reach.code === "ERR_TLS_CERT_ALTNAME_INVALID" ? "wrong cert" : "untrusted cert")]);
    case "failed":
      return typed<Line>([bad(reach.code.toLowerCase())]);
    case "refused":
      return typed<Line>([bad("refused")]);
    case "open":
      return typed<Line>([fine("open"), took(reach.ms)]);
    case "answered":
      return typed<Line>([(reach.status < 400 ? fine : reach.status < 500 ? warn : bad)(String(reach.status)), took(reach.ms)]);
  }
};

const sshCell = (reach: Reach | Pending, frame: string) => (reach.kind === "refused" ? typed<Line>([warn("off")]) : said(reach, frame));

const httpsCell = (reach: Reach | Pending, frame: string, url: string) =>
  Object.freeze(said(reach, frame).map((span, index) => (index === 0 && typeof span !== "string" ? link(span.text, url, span.tone) : span)));

/** The kayra that set the server up; where it is not the pin, the pin after it: what a setup would make it. */
const kayraCell = (running: Running | Pending, pin: KayraVersion, frame: string) => {
  switch (running.kind) {
    case "pending":
      return waiting(frame, pin.length);
    case "skipped":
      return typed<Line>([muted("–")]);
    case "recorded":
      return running.version === pin ? typed<Line>([fine(running.version)]) : typed<Line>([warn(running.version), muted(` → ${pin}`)]);
    case "unrecorded":
      return typed<Line>([warn("unrecorded"), muted(` → ${pin}`)]);
    case "unreadable":
      return typed<Line>([bad("unreadable")]);
  }
};

const headings = ["SERVER", "KIND", "TARGET", "DOMAIN", "ADDRESS", "SSH", "HTTPS", "KAYRA", "APPS"];

const probed = ["SSH", "HTTPS", "KAYRA"];

const row = (look: Look, frame: string) => {
  const { server } = look;
  return typed<readonly Line[]>([
    [strong(server.name)],
    [server.kind],
    [server.target],
    [link(server.domain, `https://${server.domain}/`)],
    machineCell(look.machine, frame),
    sshCell(look.ssh, frame),
    look.https === undefined ? [] : httpsCell(look.https, frame, authUrl(server)),
    kayraCell(look.kayra, look.pin, frame),
    [server.apps.map((app) => app.name).join(", ")],
  ]);
};

/** How the table is drawn: the spinner's frame for what is pending, the columns there are, the probes' columns or not. */
export type Drawing = { readonly frame: string; readonly room: number; readonly offline: boolean };

/** Every server in a table, then what could not be read; --offline drops the probes' columns. */
export const statusView = (looks: readonly Look[], drawing: Drawing) => {
  const shown = headings.flatMap((heading, index) => (drawing.offline && probed.includes(heading) ? Object.freeze([]) : Object.freeze([index])));
  const rows = [headings.map((heading) => Object.freeze([muted(heading)])), ...looks.map((look) => row(look, drawing.frame))].map((cells) =>
    Object.freeze(shown.map((index) => cells[index] ?? [])),
  );
  const notes = looks.flatMap((look) =>
    typed<readonly Line[]>([
      ...(look.machine.kind === "unreadable" ? [
          typed<Line>(["  ", bad("✗"), " ", strong(look.server.name), `: OpenTofu's state could not be read: ${look.machine.reason}`]),
          ...(look.machine.reason === "tofu init needed"
            ? [pointing("    ", `tofu -chdir=servers/${look.server.name}/terraform init`)]
            : []),
        ] : []),
      ...(look.kayra.kind === "unreadable"
        ? [typed<Line>(["  ", bad("✗"), " ", strong(look.server.name), `: which kayra set it up could not be read: ${look.kayra.reason}`])]
        : []),
    ]),
  );
  return typed<readonly Line[]>([...table(fit(rows, drawing.room, [shown.length - 1, shown.indexOf(3)])), ...(notes.length === 0 ? [] : [[], ...notes])]);
};
