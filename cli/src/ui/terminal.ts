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
} as const;

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Draws a line in place, again every frame, until stopped; stopping clears it. */
export const spinner = (write: (raw: string) => void, draw: (frame: string, ms: number) => string): (() => void) => {
  const started = performance.now();
  const frame = (): void => {
    const ms = performance.now() - started;
    write(`${escapes.clearLine}${draw(frames[Math.floor(ms / 80) % frames.length] ?? "", ms)}`);
  };
  frame();
  const timer = setInterval(frame, 80);
  return () => {
    clearInterval(timer);
    write(escapes.clearLine);
  };
};
