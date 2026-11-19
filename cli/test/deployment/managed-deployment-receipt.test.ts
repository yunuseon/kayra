import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { parseManagedDeploymentReceipt } from "../../src/contracts/managed-deployment-receipt.ts";

const receipt = { version: 3, protocol: "managed-v3", app: "shop", request: randomUUID(), commit: "a".repeat(40), plan: "b".repeat(64), createdAt: 1000, admissionDeadline: 91000, deadline: 1000000, phase: "accepted", outcome: null, disposition: null };

test("managed acceptance receipts distinguish intent from completed rollout outcomes", () => {
  assert.equal(parseManagedDeploymentReceipt(receipt).ok, true);
  for (const [outcome, disposition] of [["deployed", "success"], ["rolled-back", "failure"], ["absent", "failure"], ["unchanged", "cancelled"]]) assert.equal(parseManagedDeploymentReceipt({ ...receipt, phase: "complete", outcome, disposition }).ok, true);
  for (const value of [{ ...receipt, outcome: "deployed", disposition: "success" }, { ...receipt, phase: "complete" }, { ...receipt, phase: "complete", outcome: "rolled-back", disposition: "success" }, { ...receipt, phase: "complete", outcome: "deployed", disposition: "failure" }]) assert.equal(parseManagedDeploymentReceipt(value).ok, false);
});

test("managed receipts refuse altered scheduling windows, branch names and private record extensions", () => {
  for (const value of [{ ...receipt, admissionDeadline: 92000 }, { ...receipt, deadline: receipt.admissionDeadline }, { ...receipt, commit: "main" }, { ...receipt, source: "c".repeat(64) }, { ...receipt, owner: {} }]) assert.equal(parseManagedDeploymentReceipt(value).ok, false);
});
