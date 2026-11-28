import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseRegistrationGeneration, parseRegistrationObservation } from "../../src/contracts/registration-generation.ts";
import { parseApp } from "../../src/deployer/app.ts";

test("the platform publisher fixture matches the shared and legacy registration contracts", () => {
  const fixture: unknown = JSON.parse(readFileSync(new URL("../../../ci/tests/registration-generation/fixture.json", import.meta.url), "utf8"));
  if (fixture === null || typeof fixture !== "object") throw new Error("invalid fixture");
  const metadata = parseRegistrationGeneration(Reflect.get(fixture, "metadata"));
  const evidence = parseRegistrationObservation(Reflect.get(fixture, "evidence"));
  ok(metadata.ok);
  ok(evidence.ok);
  const registered = parseApp(metadata.value.app, Reflect.get(fixture, "registration"));
  ok(registered.ok);
  equal(registered.value.runtime, "compose");
  const { app, incarnation, actionId, registrationGeneration } = metadata.value;
  deepStrictEqual(evidence.value, { app, incarnation, actionId, registrationGeneration, status: "applied" });
});

test("the owner-publication fixture matches the shared contract and rejects noncanonical or changed scope", async () => {
  const { parseRegistrationOwnership } = await import("../../src/contracts/registration-ownership.ts");
  const raw: unknown = JSON.parse(readFileSync(new URL("../../../ci/tests/registration-generation/ownership.json", import.meta.url), "utf8"));
  const parsed = parseRegistrationOwnership(raw); ok(parsed.ok);
  const reference = parsed.value;
  for (const candidate of [
    { ...reference, runtime: "compose" },
    { ...reference, secret: "private" },
    { ...reference, ownership: { ...reference.ownership, dataOwner: reference.ownership.dataOwner.toUpperCase() } },
    { ...reference, ownership: { ...reference.ownership, dataOwner: reference.ownership.incarnation } },
    { ...reference, ownership: { ...reference.ownership, app: "other" } },
    { ...reference, ownership: { ...reference.ownership, dataOwner: "11111111-1111-0111-1111-111111111111" } },
  ]) equal(parseRegistrationOwnership(candidate).ok, false);
});
