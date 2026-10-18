type Env = Readonly<Record<string, string | undefined>>;

/** What kayra may do on one output stream, decided once from the stream and the environment. */
export type Screen = {
  readonly colors: boolean;
  /** A terminal kayra may draw on: spinners, a line rewritten in place. */
  readonly live: boolean;
  readonly columns: number;
  /** Escape sequences beyond text this terminal understands. */
  readonly title: boolean;
  readonly notifications: boolean;
  readonly progressBar: boolean;
  /** OSC 8: text that opens a URL. */
  readonly links: boolean;
};

/** Optique's rule too, so help and kayra agree: a nonempty FORCE_COLOR, else no NO_COLOR, then a terminal. */
export const colors = (tty: boolean, env: Env): boolean => {
  if ((env["FORCE_COLOR"] ?? "") !== "") return true;
  if ((env["NO_COLOR"] ?? "") !== "" || env["NODE_DISABLE_COLORS"] !== undefined) return false;
  return tty && env["TERM"] !== "dumb";
};

// OSC 9 is a notification in these, and OSC 9;4 a progress bar in some; elsewhere either may print as text.
const notifying = ["iTerm.app", "WezTerm", "ghostty"];
const showingProgress = ["WezTerm", "ghostty"];
const linking = ["iTerm.app", "WezTerm", "ghostty", "vscode"];

export const screen = (stream: { readonly isTTY?: boolean; readonly columns?: number }, env: Env): Screen => {
  const tty = stream.isTTY === true;
  const live = tty && env["TERM"] !== "dumb" && (env["CI"] ?? "") === "";
  const program = env["TERM_PROGRAM"] ?? "";
  // tmux and screen swallow what they do not know, or pass it to the wrong pane.
  const direct = live && env["TMUX"] === undefined && env["STY"] === undefined;
  return {
    colors: colors(tty, env),
    live,
    // A pseudo-terminal may report 0.
    columns: stream.columns !== undefined && stream.columns > 0 ? stream.columns : Number(env["COLUMNS"]) || 80,
    title: live,
    notifications: direct && notifying.includes(program),
    progressBar: direct && (showingProgress.includes(program) || env["WT_SESSION"] !== undefined),
    links: direct && linking.includes(program),
  };
};

const printable = (text: string): string => text.replace(/\p{Cc}/gu, " ");
const osc = (body: string): string => `\u001b]${body}\u0007`;

export const escapes = {
  clearLine: "\r\u001b[2K",
  /** xterm's title stack: the shell's title comes back when kayra is done. */
  pushTitle: "\u001b[22;0t",
  popTitle: "\u001b[23;0t",
  title: (text: string): string => osc(`0;${printable(text)}`),
  notify: (text: string): string => osc(`9;${printable(text)}`),
  progress: (percent: number): string => osc(`9;4;1;${String(Math.round(percent))}`),
  progressDone: osc("9;4;0;0"),
  link: (text: string, href: string): string => `${osc(`8;;${printable(href)}`)}${text}${osc("8;;")}`,
  /** To the start of the line `count` lines up; nothing for none, since CSI 0 F still moves one. */
  up: (count: number): string => (count > 0 ? `\u001b[${String(count)}F` : ""),
  clearDown: "\u001b[J",
} as const;

import type { Update } from "../../core/updates.ts";

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const frameOf = (ms: number): string => frames[Math.floor(ms / 80) % frames.length] ?? "";

/** Draws a line in place, again every frame, until stopped; stopping clears it. */
export const spinner = (write: (raw: string) => void, draw: (frame: string, ms: number) => string): (() => void) => {
  const started = performance.now();
  const frame = (): void => {
    const ms = performance.now() - started;
    write(`${escapes.clearLine}${draw(frameOf(ms), ms)}`);
  };
  frame();
  const timer = setInterval(frame, 80);
  return () => {
    clearInterval(timer);
    write(escapes.clearLine);
  };
};

/** A state change, as an answer brings it. */
const tick = (ms: number): Promise<undefined> =>
  new Promise((resolve) => {
    setTimeout(() => {
      resolve(undefined);
    }, ms);
  });

/**
 * Draws a block of lines in place, again every frame and as each update lands,
 * until all have; then clears it and returns the state they made. Each line
 * must fit the terminal: one that wraps throws the redraw off.
 */
export const watch = async <S>(
  write: (raw: string) => void,
  initial: S,
  updates: readonly Promise<Update<S>>[],
  draw: (state: S, frame: string) => readonly string[],
): Promise<S> => {
  const started = performance.now();
  const redraw = (state: S, drawn: number): number => {
    const lines = draw(state, frameOf(performance.now() - started));
    write(`${escapes.up(drawn)}${lines.map((line) => `${escapes.clearLine}${line}\n`).join("")}${escapes.clearDown}`);
    return lines.length;
  };
  type Landed = { readonly id: number; readonly update: Update<S> };
  const go = async (state: S, waiting: readonly { readonly id: number; readonly landed: Promise<Landed> }[], drawn: number): Promise<S> => {
    const shown = redraw(state, drawn);
    if (waiting.length === 0) {
      write(`${escapes.up(shown)}${escapes.clearDown}`);
      return state;
    }
    const next = await Promise.race([...waiting.map((each) => each.landed), tick(80)]);
    return next === undefined
      ? go(state, waiting, shown)
      : go(next.update(state), waiting.filter((each) => each.id !== next.id), shown);
  };
  return go(initial, updates.map((update, id) => ({ id, landed: update.then((done) => ({ id, update: done })) })), 0);
};
