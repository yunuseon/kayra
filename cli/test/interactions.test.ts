import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { absolutePath, ageKeyFile, serverName } from "../src/core/fleet/brand.ts";
import { interpret } from "../src/core/interpreter/loop.ts";
import type { Io } from "../src/core/interpreter/io.ts";
import { render } from "../src/core/plan/describe.ts";
import { run } from "../src/core/plan/model.ts";
import { reporting, type Event } from "../src/core/interpreter/events.ts";
import { must, sealed, testKey } from "./support.ts";

const server = must(serverName("box"));
const quiet = { out: () => undefined, err: () => undefined, ask: () => Promise.resolve("") };
const scratch = () => mkdtempSync(join(tmpdir(), "kayra-interactions-"));
const node = (script: string) => run("test program", [process.execPath, "-e", script]);

const secretsNeed = (file: string, use: "ansible" | "opentofu" = "ansible", key = testKey) =>
  ({ kind: "secrets", server, file: must(absolutePath(file)), key, encrypted: true, for: use }) as const;

test("secrets.yml is opened once per server and run, into a private file removed when the run ends", async () => {
  const dir = scratch();
  try {
    const file = sealed(join(dir, "secrets.yml"), "answer: opened\nterraform: {hcloud_token: t0ken}\n");
    // eslint-disable-next-line functional/prefer-immutable-types -- capturing output
    const seen: { output: string[]; events: Event[] } = { output: [], events: [] };
    const step = {
      ...node(`const fs = require('node:fs'); const file = process.env.KAYRA_SECRETS;
        process.stdout.write(JSON.stringify({file, text: fs.readFileSync(file, 'utf8'), mode: fs.statSync(file).mode & 0o777, dirMode: fs.statSync(require('node:path').dirname(file)).mode & 0o777}) + '\\n');`),
      needs: [secretsNeed(file)],
    };
    const passed = await interpret([step, step], {
      ...quiet,
      // eslint-disable-next-line functional/immutable-data -- capturing
      output: (chunk) => { seen.output.push(chunk); },
    }, reporting((event) => {
      // eslint-disable-next-line functional/immutable-data -- capturing
      seen.events.push(event);
    }, { command: "test", about: [] }, (value) => value));
    strictEqual(passed, true);
    const [first, second] = seen.output.map((line): unknown => JSON.parse(line));
    deepStrictEqual(first, second);
    if (typeof first !== "object" || first === null || !("file" in first) || typeof first.file !== "string") throw new Error("no secrets file");
    strictEqual("text" in first && typeof first.text === "string" && first.text.includes("answer: opened"), true);
    strictEqual("mode" in first && first.mode, 0o600);
    strictEqual("dirMode" in first && first.dirMode, 0o700);
    strictEqual(existsSync(first.file), false);
    strictEqual(JSON.stringify(seen.events).includes("t0ken"), false);
    strictEqual(render([step]).join("\n").includes("t0ken"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenTofu gets secrets.yml's terraform mapping as TF_VAR_*", async () => {
  const dir = scratch();
  try {
    const file = sealed(join(dir, "secrets.yml"), "host_only: x\nterraform: {hcloud_token: t0ken, state_passphrase: long enough}\n");
    const step = {
      ...node("if (process.env.TF_VAR_hcloud_token !== 't0ken' || process.env.TF_VAR_state_passphrase !== 'long enough' || process.env.TF_VAR_host_only || process.env.KAYRA_SECRETS) process.exit(1)"),
      needs: [secretsNeed(file, "opentofu")],
    };
    strictEqual(await interpret([step], quiet), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a secrets.yml its key cannot open fails before its step starts", async () => {
  const dir = scratch();
  try {
    const marker = join(dir, "ran");
    const other = join(dir, "other-key.txt");
    execFileSync("age-keygen", ["-o", other], { stdio: "pipe" });
    const file = sealed(join(dir, "secrets.yml"), "answer: opened\n");
    // eslint-disable-next-line functional/prefer-immutable-types -- capturing what kayra says
    const said: string[] = [];
    const step = { ...node(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`), needs: [secretsNeed(file, "ansible", ageKeyFile(must(absolutePath(other))))] };
    // eslint-disable-next-line functional/immutable-data -- capturing
    strictEqual(await interpret([step], { ...quiet, err: (text) => { said.push(JSON.stringify(text)); } }), false);
    strictEqual(existsSync(marker), false);
    strictEqual(said.some((line) => line.includes("cannot open")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A sudo that has no password cached, for the length of a test. */
const uncachedSudo = (dir: string) => {
  const path = process.env["PATH"];
  writeFileSync(join(dir, "sudo"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  // eslint-disable-next-line functional/immutable-data -- the stub shadows sudo only for this test
  process.env["PATH"] = `${dir}:${path ?? ""}`;
  return () => {
    // eslint-disable-next-line functional/immutable-data -- restore the operator's environment
    if (path === undefined) delete process.env["PATH"]; else process.env["PATH"] = path;
  };
};

test("declining a password does not start its step", async () => {
  const dir = scratch();
  const restore = uncachedSudo(dir);
  try {
    const marker = join(dir, "ran");
    const step = { ...node(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`), needs: [{ kind: "sudo" }] as const };
    await interpret([step], quiet);
    strictEqual(existsSync(marker), false);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelling a question ends the run and ignores a late answer", async () => {
  const dir = scratch();
  const restore = uncachedSudo(dir);
  const stop = new AbortController();
  // eslint-disable-next-line functional/prefer-immutable-types -- the pending answer and collected progress
  const pending: { answer?: (text: string) => void; events: Event[] } = { events: [] };
  const done = interpret([{ ...run("never", ["false"]), needs: [{ kind: "sudo" }] }], {
    ...quiet,
    signal: stop.signal,
    ask: () => new Promise((resolve) => {
      // eslint-disable-next-line functional/immutable-data -- saving the late answer
      pending.answer = resolve;
      stop.abort();
    }),
  }, reporting((event) => {
    // eslint-disable-next-line functional/immutable-data -- collecting
    pending.events.push(event);
  }, { command: "test", about: [] }, (value) => value));
  strictEqual(await done, false);
  pending.answer?.("too late");
  const ended = pending.events.at(-1);
  strictEqual(ended?.kind === "ended" && ended.stop?.why, "interrupted");
  strictEqual(pending.events.some((event) => event.kind === "started"), false);
  restore();
  rmSync(dir, { recursive: true, force: true });
});

test("sudo readiness is checked without stdin; an uncached password is sent only on the step's stdin", async () => {
  const dir = scratch();
  const path = process.env["PATH"];
  try {
    writeFileSync(join(dir, "sudo"), '#!/bin/sh\nread -r unexpected && exit 99\nexit 1\n', { mode: 0o700 });
    // eslint-disable-next-line functional/immutable-data -- the stub shadows sudo only for this test
    process.env["PATH"] = `${dir}:${path ?? ""}`;
    const io: Io = { ...quiet, ask: () => Promise.resolve("test-sudo-password"), output: () => undefined };
    strictEqual(await interpret([{ ...node(`let text=''; process.stdin.on('data', chunk => text+=chunk); process.stdin.on('end', () => {if(text !== 'test-sudo-password\\n' || process.env.KAYRA_SUDO_STDIN !== '1') process.exit(1)});`), needs: [{ kind: "sudo" }] }], io), true);
    writeFileSync(join(dir, "sudo"), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    strictEqual(await interpret([{ ...run("cached", ["true"]), needs: [{ kind: "sudo" }] }], {
      ...io,
      ask: () => { throw new Error("cached sudo must not ask"); },
    }), true);
  } finally {
    // eslint-disable-next-line functional/immutable-data -- restore the operator's environment
    if (path === undefined) delete process.env["PATH"]; else process.env["PATH"] = path;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a session has a terminal, the requested size, live input/output, and releases its input on exit", { timeout: 5_000 }, async (t) => {
  const stop = new AbortController();
  t.after(() => { stop.abort(); });
  // eslint-disable-next-line functional/prefer-immutable-types -- the session's incoming bytes and captured output
  const session: { deliver?: (chunk: string) => void; output: string; closed: boolean } = { output: "", closed: false };
  const passed = await interpret([{ ...run("shell", ["sh", "-c", "test -t 0 || exit 9; stty size; echo READY; read -r x; printf 'answer:%s\\n' \"$x\""]), kind: "session" }], {
    ...quiet,
    signal: stop.signal,
    size: { rows: 19, columns: 73 },
    input: (deliver) => {
      // eslint-disable-next-line functional/immutable-data -- connect this test's input
      session.deliver = deliver;
      // eslint-disable-next-line functional/immutable-data -- disconnection must run on exit
      return () => { session.closed = true; };
    },
    output: (chunk) => {
      // eslint-disable-next-line functional/immutable-data -- collecting
      session.output += chunk;
      if (chunk.includes("READY")) session.deliver?.("hello\n");
    },
  });
  strictEqual(passed, true);
  strictEqual(session.output.includes("19 73"), true);
  strictEqual(session.output.includes("answer:hello"), true);
  strictEqual(session.closed, true);
});

test("cancellation stops a session and its shell rather than leaving a child running", { timeout: 5_000 }, async () => {
  const stop = new AbortController();
  // eslint-disable-next-line functional/prefer-immutable-types -- the shell pid comes from the session's output
  const session: { pid?: number } = {};
  const passed = await interpret([{ ...run("shell", ["sh", "-c", "echo PID:$$; exec sleep 30"]), kind: "session" }], {
    ...quiet,
    signal: stop.signal,
    input: () => () => undefined,
    output: (chunk) => {
      const pid = /PID:(\d+)/.exec(chunk)?.[1];
      if (pid !== undefined) {
        // eslint-disable-next-line functional/immutable-data -- retaining pid to check for a leaked process
        session.pid = Number(pid);
        stop.abort();
      }
    },
  });
  strictEqual(passed, false);
  if (session.pid === undefined) throw new Error("shell never started");
  const alive = (): boolean => { try { process.kill(session.pid ?? 0, 0); return true; } catch { return false; } };
  strictEqual(alive(), false);
});

test("piped CLI answers remain available across questions, without echoing secrets", () => {
  const module = new URL("../src/clients/cli/questions.ts", import.meta.url).href;
  const script = `const {questions} = await import(${JSON.stringify(module)}); const input=questions(text => text); const first=await input.ask({kind:'secret',text:'first:'}); const second=await input.ask({kind:'secret',text:'second:'}); input.close(); if(first!=='one'||second!=='two') process.exit(1);`;
  strictEqual(execFileSync(process.execPath, ["--input-type=module", "-e", script], { input: "one\ntwo\n", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }), "");
});


test("the CLI hides a secret on a terminal, edits Unicode, and restores terminal mode after Enter", { timeout: 5_000 }, async (t) => {
  const stop = new AbortController();
  t.after(() => { stop.abort(); });
  const module = new URL("../src/clients/cli/questions.ts", import.meta.url).href;
  const script = `const {questions}=await import(${JSON.stringify(module)}); const input=questions(text=>text); const answer=await input.ask({kind:'secret',text:'PASSWORD:'}); input.close(); if(answer!=='unicopass'||process.stdin.isRaw) process.exit(1);`;
  // eslint-disable-next-line functional/prefer-immutable-types -- connect terminal input and collect what is shown
  const terminal: { input?: (chunk: string) => void; text: string } = { text: "" };
  const passed = await interpret([{ ...run("secret on tty", [process.execPath, "--input-type=module", "-e", script]), kind: "session" }], {
    ...quiet,
    signal: stop.signal,
    input: (deliver) => {
      // eslint-disable-next-line functional/immutable-data -- connect test keystrokes
      terminal.input = deliver;
      return () => undefined;
    },
    output: (chunk) => {
      // eslint-disable-next-line functional/immutable-data -- capture only the terminal's visible output
      terminal.text += chunk;
      if (chunk.includes("PASSWORD:")) terminal.input?.("unico🙂\u007fpass\rignored-paste");
    },
  });
  strictEqual(passed, true, terminal.text);
  strictEqual(terminal.text.includes("unico"), false);
  strictEqual(terminal.text.includes("ignored-paste"), false);
});

test("the hosts script gives sudo its password on stdin, never as an argument", { skip: process.getuid?.() === 0 && "root already has permission; this test must stop at the sudo stub" }, () => {
  const dir = scratch();
  try {
    const sudo = join(dir, "sudo");
    writeFileSync(sudo, '#!/bin/sh\n[ "$1" = -S ] || exit 4\nread -r password\n[ "$password" = test-sudo-password ] || exit 5\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
    const output = execFileSync("bash", [join(import.meta.dirname, "../../scripts/local/setup-hosts.sh"), "fixture.test", "192.0.2.1"], {
      input: "test-sudo-password\n",
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env["PATH"] ?? ""}`, KAYRA_SUDO_STDIN: "1" },
    });
    strictEqual(output.includes("test-sudo-password"), false);
    strictEqual(output.includes("setup-hosts.sh"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("the CLI accepts a typed confirmation on a terminal", { timeout: 5_000 }, async (t) => {
  const stop = new AbortController();
  t.after(() => { stop.abort(); });
  const module = new URL("../src/clients/cli/questions.ts", import.meta.url).href;
  const script = `const {questions}=await import(${JSON.stringify(module)}); const input=questions(text=>text); const answer=await input.ask({kind:'confirm',text:'Type box:',expect:'box'}); input.close(); if(answer!=='box') process.exit(1);`;
  const terminal: { input?: (chunk: string) => void } = {};
  strictEqual(await interpret([{ ...run("confirmation on tty", [process.execPath, "--input-type=module", "-e", script]), kind: "session" }], {
    ...quiet,
    signal: stop.signal,
    input: (deliver) => {
      // eslint-disable-next-line functional/immutable-data -- connect the test keystrokes
      terminal.input = deliver;
      return () => undefined;
    },
    output: (chunk) => { if (chunk.includes("Type box:")) terminal.input?.("box\n"); },
  }), true);
});


test("a cancel before the spawn event waits for the process group to exist", { timeout: 5_000 }, async () => {
  const stop = new AbortController();
  const passed = await interpret([{ ...run("cancel immediately", ["sleep", "30"]), kind: "session" }], {
    ...quiet,
    signal: stop.signal,
    output: () => undefined,
    input: () => { stop.abort(); return () => undefined; },
  });
  strictEqual(passed, false);
});
