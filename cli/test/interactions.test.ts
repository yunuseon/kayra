import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serverName } from "../src/core/brand.ts";
import { interpret, type Io, type Question } from "../src/core/interpret.ts";
import { render, run } from "../src/core/plan.ts";
import { reporting, type Event } from "../src/core/present/progress.ts";
import { must } from "./support.ts";

const server = must(serverName("box"));
const quiet = { out: () => undefined, err: () => undefined, ask: () => Promise.resolve("") };
const scratch = () => mkdtempSync(join(tmpdir(), "kayra-interactions-"));
const node = (script: string) => run("test program", [process.execPath, "-e", script]);

test("vault passwords are asked once per server and run, absent from plans and records, and their helper is removed", async () => {
  // eslint-disable-next-line functional/prefer-immutable-types -- capturing interpreter output and questions
  const seen: { questions: Question[]; output: string[]; events: Event[] } = { questions: [], output: [], events: [] };
  const secret = "a test password ' $ with spaces";
  const step = {
    ...node(`const fs = require('node:fs'); const cp = require('node:child_process');
      const helper = process.env.ANSIBLE_VAULT_PASSWORD_FILE;
      const password = cp.execFileSync(helper, {encoding:'utf8'}).trimEnd();
      if (require("node:crypto").createHash("sha256").update(password).digest("hex") !== ${JSON.stringify(createHash("sha256").update(secret).digest("hex"))}) process.exit(1);
      process.stdout.write(JSON.stringify({helper, mode:fs.statSync(helper).mode & 0o777, dirMode:fs.statSync(require('node:path').dirname(helper)).mode & 0o777}));`),
    needs: [{ kind: "vault", server }] as const,
  };
  const passed = await interpret([step, step, node("if (process.env.KAYRA_VAULT_PASSWORD) process.exit(1)")], {
    ...quiet,
    ask: (question) => {
      // eslint-disable-next-line functional/immutable-data -- capturing
      seen.questions.push(question);
      return Promise.resolve(secret);
    },
    // eslint-disable-next-line functional/immutable-data -- capturing
    output: (chunk) => { seen.output.push(chunk); },
  }, reporting((event) => {
    // eslint-disable-next-line functional/immutable-data -- capturing
    seen.events.push(event);
  }, { command: "test", about: [] }, (value) => value));
  strictEqual(passed, true);
  deepStrictEqual(seen.questions.map((question) => question.kind), ["secret"]);
  const data: unknown = JSON.parse(seen.output[0] ?? "");
  if (typeof data !== "object" || data === null || !("helper" in data) || typeof data.helper !== "string") throw new Error("no helper path");
  strictEqual(existsSync(data.helper), false);
  strictEqual("mode" in data && data.mode, 0o700);
  strictEqual("dirMode" in data && data.dirMode, 0o700);
  strictEqual(JSON.stringify(seen.events).includes(secret), false);
  strictEqual(render([step]).join("\n").includes(secret), false);
});

test("a real Ansible vault is opened through the environment-backed password helper", () => {
  const dir = scratch();
  try {
    const helper = join(dir, "test-password");
    const vault = join(dir, "vault.yml");
    writeFileSync(helper, '#!/bin/sh\nprintf "%s\\n" "$TEST_VAULT_PASSWORD"\n', { mode: 0o700 });
    writeFileSync(vault, "answer: opened\n");
    const env = { ...process.env, ANSIBLE_LOCAL_TEMP: join(dir, "ansible"), TEST_VAULT_PASSWORD: "test-vault-password" };
    execFileSync("ansible-vault", ["encrypt", "--vault-password-file", helper, vault], { env, stdio: "pipe" });
    // The fixture password only creates the test vault; the interpreter must supply its own helper.
    return interpret([{ ...run("open vault", ["ansible-vault", "view", vault], { ANSIBLE_LOCAL_TEMP: join(dir, "ansible") }), needs: [{ kind: "vault", server }] }], {
      ...quiet,
      ask: () => Promise.resolve("test-vault-password"),
      output: (chunk) => { strictEqual(chunk, "answer: opened\n"); },
    }).then((passed) => { strictEqual(passed, true); }).finally(() => { rmSync(dir, { recursive: true, force: true }); });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
});

test("declining a secret does not start its step", async () => {
  const dir = scratch();
  try {
    const marker = join(dir, "ran");
    const step = { ...node(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`), needs: [{ kind: "vault", server }] as const };
    await interpret([step], quiet);
    strictEqual(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelling a question ends the run and ignores a late answer", async () => {
  const stop = new AbortController();
  // eslint-disable-next-line functional/prefer-immutable-types -- the pending answer and collected progress
  const pending: { answer?: (text: string) => void; events: Event[] } = { events: [] };
  const done = interpret([{ ...run("never", ["false"]), needs: [{ kind: "vault", server }] }], {
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
});

test("sudo readiness is checked without stdin; an uncached password is sent only on the step's stdin", async () => {
  const dir = scratch();
  const path = process.env["PATH"];
  try {
    writeFileSync(join(dir, "sudo"), '#!/bin/sh\nread -r unexpected && exit 99\nexit 1\n', { mode: 0o700 });
    // eslint-disable-next-line functional/immutable-data -- the stub shadows sudo only for this test
    process.env["PATH"] = `${dir}:${path ?? ""}`;
    const io: Io = { ...quiet, ask: () => Promise.resolve("test-sudo-password"), output: () => undefined };
    strictEqual(await interpret([{ ...node(`let text=''; process.stdin.on('data', chunk => text+=chunk); process.stdin.on('end', () => {if(text !== 'test-sudo-password\\n' || process.env.KAYRA_SUDO_STDIN !== '1' || process.env.KAYRA_VAULT_PASSWORD) process.exit(1)});`), needs: [{ kind: "sudo" }] }], io), true);
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
