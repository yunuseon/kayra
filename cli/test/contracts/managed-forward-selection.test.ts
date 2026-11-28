import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { parseManagedForwardSelectionRequest } from "../../src/contracts/managed-forward-selection.ts";

test("forward selection requests name exact scoped commits and cannot supply actor or execution authority", () => {
  const request = { app: "shop", blockedRun: randomUUID(), request: randomUUID(), commit: "a".repeat(40), reason: "Build a reviewed forward recovery fix" };
  assert.equal(parseManagedForwardSelectionRequest(request).ok, true);
  for (const invalid of [{ ...request, request: request.blockedRun }, { ...request, commit: "main" }, { ...request, commit: "a".repeat(12) }, { ...request, app: "../shop" }, { ...request, reason: "yes" }, { ...request, reason: "unsafe\nreason" }, { ...request, actor: { identity: "invented" } }, { ...request, runtime: "swarm" }, { ...request, buildDeadline: Date.now() + 90000 }, { ...request, createdAt: 1000 }, { ...request, plan: {} }]) assert.equal(parseManagedForwardSelectionRequest(invalid).ok, false);
});
