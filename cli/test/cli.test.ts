import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { run } from "@optique/run";
import { parser, runOptions } from "../src/clients/cli/parser.ts";
import { fleet, server } from "./support.ts";

const servers = fleet(
  server("shop-test", "target: multipass\ndomain: shop.test\n"),
  server("shop-prod", "target: hetzner\ndomain: shop.example"),
);

type Ran = { readonly value: unknown; readonly out: string; readonly err: string; readonly exit: number | undefined };

/** kayra's arguments as a terminal 80 columns wide and without colours gets them, exiting by throwing. */
const kayra = (...args: readonly string[]): Ran => {
  // eslint-disable-next-line functional/prefer-immutable-types -- capturing what Optique writes
  const said: { out: string[]; err: string[] } = { out: [], err: [] };
  const written = (exit: number | undefined, value?: unknown): Ran => ({ value, out: said.out.join("\n"), err: said.err.join("\n"), exit });
  try {
    const value = run(parser(servers), {
      ...runOptions("1.2.3"),
      args,
      colors: false,
      maxWidth: 80,
      // eslint-disable-next-line functional/immutable-data -- capturing
      stdout: (text) => said.out.push(text),
      // eslint-disable-next-line functional/immutable-data -- capturing
      stderr: (text) => said.err.push(text),
      onExit: (code) => {
        throw new Error("exit", { cause: code });
      },
    });
    return written(undefined, value);
  } catch (error) {
    if (!(error instanceof Error) || typeof error.cause !== "number") throw error;
    return written(error.cause);
  }
};

test("--dry-run and -v/--verbose go anywhere on the line", () => {
  deepStrictEqual(kayra("setup", "shop-test").value, { dryRun: false, verbose: false, command: { name: "setup", server: "shop-test" } });
  for (const args of [["-v", "setup", "shop-test"], ["setup", "--verbose", "shop-test"], ["setup", "shop-test", "-v", "--dry-run"]]) {
    const { value } = kayra(...args);
    ok(typeof value === "object" && value !== null && "verbose" in value && value.verbose === true, args.join(" "));
  }
  deepStrictEqual(kayra("ssh", "shop-test", "--", "df", "-h", "/").value, {
    dryRun: false,
    verbose: false,
    command: { name: "ssh", server: "shop-test", remote: ["df", "-h", "/"] },
  });
});

test("a misspelt server, job or command gets a did-you-mean, without the usage above it", () => {
  const server = kayra("deploy", "shop-tset");
  strictEqual(server.exit, 1);
  ok(server.err.startsWith("Error: "), server.err);
  ok(server.err.includes('Did you mean "shop-test"?'), server.err);
  ok(kayra("job", "shop-prod", "gcc").err.includes('Did you mean "gc"?'));
  ok(kayra("stauts").err.includes("Did you mean `status`?"));
});

test("kayra --help: the commands in sections, the options, examples and the docs", () => {
  const help = kayra("--help");
  strictEqual(help.exit, 0);
  const headings = help.out.split("\n").filter((line) => /^\S.*:$/.test(line));
  deepStrictEqual(headings, ["On a server:", "Apps on a server:", "The whole fleet:", "Options:", "Help:", "Examples:"]);
  ok(help.out.startsWith("kayra 1.2.3: "), help.out);
  ok(help.out.includes("\nUsage: kayra [--dry-run] [-v/--verbose] COMMAND [ARG...]\n"), help.out);
  ok(help.out.includes("\n  -v, --verbose  Ansible's own output (with -v) instead of kayra's summary.\n"), help.out);
  ok(help.out.includes("\n  kayra deploy shop-prod --dry-run  every step it would run, running none\n"), help.out);
  ok(help.out.endsWith("Docs: <https://yunuseon.github.io/kayra/>"), help.out);
  ok(!/^\s+ARG\b/m.test(help.out), "completion's ARG is not a command");
});

test("a command's help: what it does, its arguments with the fleet's servers, examples, the docs", () => {
  for (const args of [["deploy", "--help"], ["help", "deploy"], ["deploy", "-h"]]) {
    const help = kayra(...args);
    strictEqual(help.exit, 0);
    ok(help.out.startsWith("Host setup and every app, no provisioning.\nUsage: kayra deploy [--dry-run] [-v/--verbose] SERVER\n"), help.out);
    ok(help.out.includes("\n  SERVER         A server (choices: shop-test, shop-prod)\n"), help.out);
    ok(help.out.includes("\nExamples:\n  kayra deploy shop-prod            after a new kayra or a fleet change\n"), help.out);
    ok(help.out.endsWith("\n\nDocs: <https://yunuseon.github.io/kayra/>"), help.out);
  }
  ok(kayra("app", "--help").out.includes("\nIn an app's repository:\n  init "));
  ok(kayra("job", "--help").out.includes("JOB            Which job (choices: gc, renovate)"));
});

test("serve selects either client or both, and replaces the old ui command", () => {
  deepStrictEqual(kayra("serve", "--api", "--ui", "--no-open", "--port", "7700").value, {
    dryRun: false, verbose: false,
    command: { name: "serve", ui: true, api: true, noOpen: true, port: 7700 },
  });
  strictEqual(kayra("ui").exit, 1);
});
