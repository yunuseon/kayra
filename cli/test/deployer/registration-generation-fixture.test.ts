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
