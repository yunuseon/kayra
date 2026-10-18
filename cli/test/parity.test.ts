import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { parseSync } from "@optique/core";
import { fromCommand, reaches } from "../src/clients/cli/invocation.ts";
import { parser } from "../src/clients/cli/parser.ts";
import { operation, operationNames } from "../src/core/operations/catalog.ts";
import { fleet, server } from "./support.ts";

// Every client offers every kayra operation. The command line's share: each
// catalog operation has a sample argument list (reaches, which the compiler
// already holds complete), and parsing it lands on that very operation.

const shop = server("shop", "target: multipass\ndomain: shop.test\nvault: false\napps: [{name: shop, repo: https://git.example/shop.git}]", {
  secrets: "a: b\n",
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
