import { createHash } from "node:crypto";
import { z } from "zod";
import { parseManagedApplicationPlan, managedApplicationDigest } from "../../contracts/managed-application-plan.ts";
import { managedServiceDigest } from "../../contracts/managed-service-plan.ts";
import { parseManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import { routedHttp } from "./http-convergence.ts";
import { parseManagedConsumerState } from "./managed-consumer-state.ts";
import { parseManagedGroupCompensation } from "./managed-group-compensation.ts";
import { managedRecoverySnapshot, managedRecoveryDigest } from "./managed-recovery-description.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const native = z.object({ id: z.string().regex(/^[a-z0-9]{25}$/), version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().readonly();
const references = z.array(z.object({ name: z.string(), action: z.unknown(), native }).strict().readonly()).max(32).readonly();
const schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("deployment"), application: z.unknown(), certificate: z.unknown() }).strict().readonly(),
  z.object({ kind: z.literal("recovery"), application: z.unknown(), certificate: z.unknown(), recoverySource: z.unknown() }).strict().readonly(),
]);

/** A separate stable identity prevents candidate and restored-release checks from sharing application deduplication keys. */
export const recoveryCheckRun = (run: string, application: string) => {
  if (!z.uuid().safeParse(run).success || !/^[a-f0-9]{64}$/.test(application)) throw new Error("invalid recovery check identity");
  const bytes = hash({ run, application, purpose: "recovery-check" });
  return `${bytes.slice(0, 8)}-${bytes.slice(8, 12)}-4${bytes.slice(13, 16)}-8${bytes.slice(17, 20)}-${bytes.slice(20, 32)}`;
};

/** Validates historical native/routed evidence only. Verification must refresh every workload and route after checks before release promotion. */
export const managedVerificationSnapshot = (input: unknown) => {
  const raw = schema.parse(input); const checked = parseManagedApplicationPlan(raw.application); if (!checked.ok) throw new Error("invalid managed verification application"); const application = checked.value;
  const digest = managedApplicationDigest(application); const owner = application.infrastructure.ownership;
  const selected = raw.kind === "deployment" ? (() => {
    const certificate = parseManagedConsumerState(raw.certificate); if (certificate.phase !== "ready" || certificate.verifiedAt === null || certificate.plan !== digest) throw new Error("managed verification requires ready consumers");
    if (Object.values(application.services).some((service) => service.role === "http" && !certificate.nodes.some((node) => node.name === service.service && node.ready?.kind === "running" && node.ready.routed !== null && routedHttp(node.ready.action, node.ready.routed, certificate.verifiedAt ?? 0)))) throw new Error("managed verification HTTP evidence missing");
    const witnesses = [...certificate.retained, ...certificate.nodes.flatMap((node) => node.ready?.kind === "running" ? Object.freeze([Object.freeze({ name: node.name, action: node.ready.action, native: node.ready.native })]) : Object.freeze([]))];
    return Object.freeze({ certificate, source: Object.freeze({ kind: "deployment" as const, application, certificate }), witnesses: Object.freeze(witnesses), run: certificate.run, at: certificate.verifiedAt });
  })() : (() => {
    const certificate = parseManagedGroupCompensation(raw.certificate); const snapshot = managedRecoverySnapshot(raw.recoverySource); const description = snapshot.description;
    if (certificate.phase !== "verified" || certificate.verifiedAt === null || certificate.previous !== digest || snapshot.source.previous === null || managedApplicationDigest(snapshot.source.previous) !== digest || hash(snapshot.source) !== certificate.source || managedRecoveryDigest(description) !== certificate.description ||
      certificate.app !== description.app || certificate.incarnation !== description.incarnation || certificate.dataOwner !== description.dataOwner || certificate.run !== description.run || certificate.action !== description.action || certificate.plan !== description.plan ||
      !same(description.nodes, certificate.nodes.map(({ name, plan, baseline, prior }) => Object.freeze({ name, plan, baseline, prior })))) throw new Error("managed verification recovery evidence disagrees");
    if (Object.values(application.services).some((service) => service.role === "http" && !certificate.nodes.some((node) => { const action = node.child?.attempts.at(-1)?.action; return node.name === service.service && action !== undefined && node.routed !== null && routedHttp(action, node.routed, certificate.verifiedAt ?? 0); }))) throw new Error("managed verification restored HTTP evidence missing");
    const witnesses = [...description.retained, ...certificate.nodes.flatMap((node) => {
      const service = application.services[node.name]; if (service === undefined) return Object.freeze([]);
      const action = node.child?.attempts.at(-1)?.action; const proof = node.child?.proof;
      if (node.child?.phase !== "complete" || action === undefined || proof === null || proof === undefined) throw new Error("managed verification restored service evidence missing");
      return Object.freeze([Object.freeze({ name: node.name, action, native: proof.native })]);
    })];
    return Object.freeze({ certificate, source: Object.freeze({ kind: "recovery" as const, application, certificate, recoverySource: snapshot.source }), witnesses: Object.freeze(witnesses), run: certificate.run, at: certificate.verifiedAt });
  })();
  if (selected.certificate.app !== owner.app || selected.certificate.incarnation !== owner.incarnation || selected.certificate.dataOwner !== owner.dataOwner) throw new Error("managed verification ownership disagrees");
  const witnesses = Object.freeze(references.parse(selected.witnesses).map((value) => {
    const action = parseManagedServiceAction(value.action); const service = application.services[value.name];
    if (!action.ok || service === undefined || action.value.app !== owner.app || action.value.incarnation !== owner.incarnation || action.value.dataOwner !== owner.dataOwner || action.value.service !== value.name || action.value.plan !== managedServiceDigest(service) || action.value.effect !== "apply" && action.value.effect !== "restore") throw new Error("managed verification workload scope disagrees");
    return Object.freeze({ ...value, action: action.value });
  }).toSorted((left, right) => left.name.localeCompare(right.name)));
  if (witnesses.length !== Object.keys(application.services).length || new Set(witnesses.map((value) => value.name)).size !== witnesses.length || application.rollout.checks.length > 128) throw new Error("managed verification service set or check count disagrees");
  const window = Math.max(90_000, application.rollout.checks.reduce((total, check) => total + (90 + check.timeout_seconds) * 1000, 0)); const deadline = selected.at + window;
  if (!Number.isSafeInteger(deadline)) throw new Error("managed verification deadline exceeds clock range");
  return Object.freeze({ source: selected.source, application, plan: digest, run: selected.run, checkRun: raw.kind === "deployment" ? selected.run : recoveryCheckRun(selected.run, digest), createdAt: selected.at, deadline, witnesses });
};
