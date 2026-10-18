import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { parseSync } from "@optique/core";
import { fromCommand, reaches } from "../src/clients/cli/invocation.ts";
import { parser } from "../src/clients/cli/parser.ts";
import { operation, operationNames } from "../src/core/operations/catalog.ts";
import { catalog } from "../src/clients/api/contract.ts";
import { defaults, fields, inputOf, onServer, reaches as uiReaches } from "../../web/src/operations.ts";
import { fleet, server } from "./support.ts";

// Every client offers every kayra operation. The command line's share: each
// catalog operation has a sample argument list (reaches, which the compiler
// already holds complete), and parsing it lands on that very operation.

const shop = server(
  "shop",
  "target: multipass\ndomain: shop.test\nvault: false\napps: [{name: shop, repo: https://git.example/shop.git}]",
  {
    secrets: "a: b\n",
  },
);

test("server action bars offer SSH everywhere, hosts only for multipass, and app operations only on platform servers", () => {
  const facts = { name: "lab", kind: "platform", target: "multipass", domain: "lab.test", apps: [], commands: ["deploy", "job"] } as const;
  const offered = onServer(catalog(), facts).map((info) => info.name);
  strictEqual(
    offered.includes("hosts") &&
      offered.includes("ssh") &&
      offered.includes("ssh.exec") &&
      offered.includes("app.purge") &&
      offered.includes("job"),
    true,
  );
  const nas = onServer(catalog(), { ...facts, kind: "nas", target: "home", commands: ["setup"] }).map((info) => info.name);
  strictEqual(nas.includes("ssh") && nas.includes("setup"), true);
  strictEqual(nas.includes("hosts") || nas.includes("app.deploy") || nas.includes("job"), false);
});
const commandLine = parser(fleet(shop));

test("the command line reaches every operation in the catalog, each by its own words", () => {
  operationNames.forEach((name) => {
    const argv = reaches[name].map((word) => (word === "SERVER" ? "shop" : word === "APP" ? "shop" : word));
    // Optique answers --version before kayra's own parser: kayra's version is its package's.
    if (name === "version") {
      deepStrictEqual(argv, ["--version"]);
      return;
    }
    const parsed = parseSync(commandLine, argv);
    strictEqual(parsed.success, true, `${name}: ${argv.join(" ")} does not parse`);
    const { command } = parsed.value;
    strictEqual(command.name === "serve", false);
    if (command.name === "serve") return;
    strictEqual(fromCommand(command).invocation.name, name, `${argv.join(" ")} lands elsewhere`);
  });
});

test("every operation says what it does, in one line, for every client to show", () => {
  operationNames.forEach((name) => {
    const { summary } = operation(name);
    strictEqual(summary.length > 0 && !summary.includes("\n"), true, name);
  });
});

test("every operation has a UI entry and its schema form preserves the CLI's invocation", () => {
  deepStrictEqual(Object.keys(uiReaches).toSorted(), [...operationNames].toSorted());
  catalog().forEach((info) => {
    strictEqual(uiReaches[info.name].label.length > 0 && uiReaches[info.name].icon.length > 0, true, info.name);
    strictEqual(
      fields(info.input).every((field) => field.supported),
      true,
      `${info.name}: unsupported form input`,
    );
    const argv = reaches[info.name].map((word) => (word === "SERVER" ? "shop" : word === "APP" ? "shop" : word));
    const parsed = info.name === "version" ? undefined : parseSync(commandLine, argv);
    if (parsed !== undefined && !parsed.success) throw new Error(`${info.name} does not parse`);
    const command = parsed?.value.command;
    const seed = command === undefined || command.name === "serve" ? {} : fromCommand(command).invocation.input;
    const original = operation(info.name).input.parse(seed);
    const edited = inputOf(info.input, defaults(info.input, seed));
    deepStrictEqual(operation(info.name).input.parse(edited), original, info.name);
  });
});
