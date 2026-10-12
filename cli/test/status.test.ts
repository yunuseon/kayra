import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { statusLine, unreadable } from "../src/commands/status.ts";
import { server } from "./support.ts";

const shop = server("shop-prod", "target: hetzner\ndomain: shop.example\nvault: true");

test("status tells an unreadable state apart from an empty one", () => {
  strictEqual(statusLine(shop, { kind: "none" }).endsWith("  not provisioned"), true);
  strictEqual(statusLine(shop, { kind: "provisioned", ip: "192.0.2.1" }).endsWith("  provisioned (192.0.2.1)"), true);
  strictEqual(
    statusLine(shop, { kind: "unreadable", reason: "tofu init needed" }).endsWith("  state unreadable: tofu init needed"),
    true,
  );
});

test("tofu's error, in a few words", () => {
  strictEqual(
    unreadable(
      "╷\n│ Error: Required plugins are not installed\n│\n│ The installed provider plugins are not consistent … run \"tofu init\".\n╵\n",
    ),
    "tofu init needed",
  );
  strictEqual(unreadable("╷\n│ Error: Failed to load state: permission denied\n╵\n"), "Failed to load state: permission denied");
  strictEqual(unreadable(""), "tofu failed");
});
