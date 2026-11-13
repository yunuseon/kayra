/* Private state validation grants no workload authority. The indexed writer
 * authenticates registration, fences lifecycle work and reserves resources;
 * runtime observations separately establish effect and release outcomes. */
/* eslint-disable functional/prefer-immutable-types */
import { z } from "zod";
import { err, ok } from "../../lib/result.ts";
import { parseRegistrationGeneration } from "../../contracts/registration-generation.ts";
import { httpReleasePlan, parseHttpState, terminalHttp } from "./http-state.ts";
import { lifecycleActionId, parseLifecycleFence } from "./lifecycle-fence.ts";
import { admitTicket, lookupTicket, parseTicketState } from "./lifecycle-tickets.ts";
import { parseRolloutRequest } from "./rollout-request.ts";

// Snapshot only narrowly defined references; the ticket module independently
// validates and hashes them, so a mismatch between the schemas fails closed.
// Registration and ownership generations are independent references, not app
// incarnation IDs. This parser cannot authenticate either without registries.
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const registrationGenerationId = uuid;
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const descriptor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("register"), registrationGeneration: uuid }).strict(),
  z.object({ kind: z.literal("deploy"), planDigest: digest }).strict(),
  z.object({ kind: z.literal("restore"), planDigest: digest }).strict(),
  z.object({ kind: z.literal("remove"), ownershipGeneration: uuid }).strict(),
  z.object({ kind: z.literal("purge"), ownershipGeneration: uuid }).strict(),
]);
const shape = z.object({
  version: z.literal(1),
  // A durable app index and monotonic owner are mandatory: this marker alone
  // cannot authenticate history or detect that both it and the fence were reset.
  created: z.boolean(),
  fence: z.unknown(),
  tickets: z.unknown(),
  registrationAllocation: z.object({ generation: uuid, ticket: z.string().max(80), runtime: z.enum(["compose", "swarm"]).default("compose") }).strict().optional(),
  registrationReceipt: z.object({ ticket: z.string().max(80), runtime: z.enum(["compose", "swarm"]), metadata: z.unknown() }).strict().optional(),
  http: z.unknown().optional(),
  rollout: z.unknown().optional(),
  rollouts: z.array(z.unknown()).max(1024).optional(),
  operations: z.array(z.object({ ticket: z.string().max(80), action: z.string().max(80), descriptor }).strict()).max(2),
}).strict();

/** Validate every in-flight action and ticket against the same app incarnation. */
export const parseLifecycleEnvelope = (input: unknown) => {
  const parsed = shape.safeParse(input);
  if (!parsed.success) return err("invalid lifecycle envelope");
  const tickets = parseTicketState(parsed.data.tickets);
  if (!tickets.ok) return err("invalid lifecycle envelope");
  const fence = parsed.data.fence === null ? ok(null) : parseLifecycleFence(parsed.data.fence);
  if (!fence.ok) return err("invalid lifecycle envelope");
  if (parsed.data.created !== (fence.value !== null) || (fence.value === null && tickets.value.receipts.length !== 0)) return err("invalid lifecycle envelope");
  if (fence.value !== null && (fence.value.app !== tickets.value.app || fence.value.generation !== tickets.value.incarnation)) return err("invalid lifecycle envelope");

  const allocation = parsed.data.registrationAllocation;
  const bound = allocation === undefined ? undefined : admitTicket(tickets.value, allocation.ticket, { kind: "register", registrationGeneration: allocation.generation });
  // Older journals can gain a certificate only from a still-present verified receipt.
  const legacyReceipt = allocation !== undefined && bound?.ok && bound.value.status === "terminal" && bound.value.outcome === "success"
    ? { ticket: allocation.ticket, runtime: allocation.runtime, metadata: {
      version: 1, app: tickets.value.app, incarnation: tickets.value.incarnation,
      actionId: `${tickets.value.incarnation}:1`, registrationGeneration: allocation.generation,
    } } : undefined;
  const supplied = parsed.data.registrationReceipt ?? legacyReceipt;
  const metadata = supplied === undefined ? undefined : parseRegistrationGeneration(supplied.metadata);
  if (supplied !== undefined && !metadata?.ok) return err("invalid registration certificate");
  const receipt = supplied === undefined || !metadata?.ok ? undefined : Object.freeze({ ticket: supplied.ticket, runtime: supplied.runtime, metadata: metadata.value });
  if (receipt !== undefined) {
    if (allocation === undefined || !parsed.data.created || fence.value === null || receipt.ticket !== allocation.ticket || receipt.runtime !== allocation.runtime ||
      receipt.metadata.app !== tickets.value.app || receipt.metadata.incarnation !== tickets.value.incarnation ||
      receipt.metadata.actionId !== `${tickets.value.incarnation}:1` || receipt.metadata.registrationGeneration !== allocation.generation) return err("invalid registration certificate");
    const lookup = lookupTicket(tickets.value, allocation.ticket);
    if (!lookup.ok || (lookup.value.status !== "expired" && (!bound?.ok || bound.value.status !== "terminal" || bound.value.outcome !== "success"))) return err("registration certificate conflicts with ticket history");
  } else if (allocation !== undefined && (!bound?.ok || (bound.value.status === "new") !== !parsed.data.created ||
    (bound.value.status === "accepted" && !parsed.data.operations.some((operation) => operation.ticket === allocation.ticket)))) {
    return err("invalid initial registration allocation");
  }

  const current = fence.value?.lifecycle;
  const action = current !== undefined && "active" in current ? current.active : null;
  const expected = [
    ...(action === null || fence.value === null ? [] : [{ id: lifecycleActionId(fence.value, action.sequence), kind: action.kind }]),
    ...(current !== undefined && fence.value !== null && (current.phase === "removal-requested" || current.phase === "removing")
      ? [{ id: lifecycleActionId(fence.value, current.removal), kind: "remove" as const }] : []),
    ...(current?.phase === "purging" && fence.value !== null ? [{ id: lifecycleActionId(fence.value, current.purge), kind: "purge" as const }] : []),
  ];
  const operations = parsed.data.operations;
  const accepted = tickets.value.active.filter((item) => item.phase === "accepted");
  if (operations.length !== expected.length || operations.length !== accepted.length ||
    new Set(operations.map((item) => item.action)).size !== operations.length ||
    new Set(operations.map((item) => item.ticket)).size !== operations.length) return err("invalid lifecycle envelope");

  const consistent = operations.every((operation) => {
    const target = expected.find((item) => item.id === operation.action);
    if (target?.kind !== operation.descriptor.kind) return false;
    const admitted = admitTicket(tickets.value, operation.ticket, operation.descriptor);
    return admitted.ok && admitted.value.status === "accepted";
  });
  if (!consistent) return err("invalid lifecycle envelope");
  const http = parsed.data.http === undefined ? undefined : parseHttpState(parsed.data.http, tickets.value.app, tickets.value.incarnation);
  if (http !== undefined && (!http.ok || receipt?.runtime !== "swarm")) return err("invalid Swarm HTTP envelope");
  if (http?.ok) {
    for (const request of http.value.requests) {
      const lookup = lookupTicket(tickets.value, request.ticket);
      const binding = admitTicket(tickets.value, request.ticket, { kind: "deploy", planDigest: httpReleasePlan(request) });
      if (!lookup.ok) return err("HTTP request has an unissued ticket");
      if (terminalHttp(request.phase)) {
        const outcome = request.phase === "succeeded" ? "success" : request.phase === "cancelled" ? "cancelled" : "failure";
        if (lookup.value.status !== "expired" && (!binding.ok || binding.value.status !== "terminal" || binding.value.outcome !== outcome)) return err("HTTP receipt conflicts with ticket history");
      } else if (!binding.ok || binding.value.status !== "accepted" || !operations.some((operation) => operation.ticket === request.ticket && operation.action === request.action && operation.descriptor.kind === "deploy" && operation.descriptor.planDigest === httpReleasePlan(request))) return err("HTTP request lacks lifecycle intent");
    }
  }
  const rollout = (() => {
    if (parsed.data.rollout === undefined) return undefined;
    try { return parseRolloutRequest(parsed.data.rollout); } catch { return null; }
  })();
  if (rollout === null) return err("invalid complete rollout envelope");
  const rollouts = (() => {
    try { return parsed.data.rollouts?.map(parseRolloutRequest); } catch { return null; }
  })();
  if (rollouts === null) return err("invalid complete rollout history");
  const history = [...(rollouts ?? []), ...(rollout === undefined ? [] : [rollout])];
  if (["ticket", "action", "run"].some((key) => new Set(history.map((item) => key === "ticket" ? item.ticket : key === "action" ? item.action : item.preparation.run)).size !== history.length)) return err("duplicate complete rollout identity");
  if (history.some((item, index) => index > 0 && Number(item.action.split(":")[1]) <= Number(history[index - 1]?.action.split(":")[1]))) return err("complete rollout history changed order");
  for (const owner of history) {
    const preparation = owner.preparation;
    const binding = admitTicket(tickets.value, owner.ticket, { kind: "deploy", planDigest: preparation.plan });
    const request = http?.ok ? http.value.requests.find((item) => item.request === preparation.run) : undefined;
    if (receipt?.runtime !== "swarm" || preparation.app !== tickets.value.app || preparation.incarnation !== tickets.value.incarnation ||
      request !== undefined && (!owner.admitted || preparation.phase !== "ready" || request.ticket !== owner.ticket || request.action !== owner.action || request.commit !== owner.commit ||
        request.plan !== preparation.workload || request.deployment !== preparation.plan || request.deadline !== preparation.httpDeadline)) return err("complete rollout HTTP handoff changed");
    if (owner.completion !== undefined) {
      const completion = owner.completion; const lookup = lookupTicket(tickets.value, owner.ticket);
      const previous = completion.previous; const certificates = http?.ok ? http.value.requests.flatMap((item) => [item.verified, item.recovery?.verified ?? null]) : [];
      if (request !== undefined || !lookup.ok || lookup.value.status !== "expired" && (!binding.ok || binding.value.status !== "terminal" ||
        binding.value.outcome !== (completion.outcome === "cancelled" ? "cancelled" : "failure")) || previous !== null &&
        !certificates.some((certificate) => certificate !== null && httpReleasePlan(certificate) === previous && Number(certificate.action.split(":")[1]) < Number(owner.action.split(":")[1]))) return err("unstarted complete rollout lacks terminal ownership proof");
    } else if (request !== undefined && terminalHttp(request.phase)) {
      const lookup = lookupTicket(tickets.value, owner.ticket);
      if (!lookup.ok || lookup.value.status !== "expired" && (!binding.ok || binding.value.status !== "terminal")) return err("complete rollout lacks terminal receipt");
    } else if (owner !== rollout || !binding.ok || binding.value.status !== "accepted" ||
      !operations.some((operation) => operation.ticket === owner.ticket && operation.action === owner.action && operation.descriptor.kind === "deploy" && operation.descriptor.planDigest === preparation.plan) ||
      http?.ok && http.value.requests.some((item) => !terminalHttp(item.phase) && item !== request)) return err("complete rollout lacks exclusive lifecycle intent");
  }
  if (http?.ok && http.value.requests.some((request) => request.deployment !== undefined && !history.some((owner) => owner.preparation.run === request.request))) return err("HTTP projection lacks its complete rollout owner");
  const first = history[0];
  if (first !== undefined && http?.ok && http.value.requests.some((request) => request.deployment === undefined && Number(request.action.split(":")[1]) > Number(first.action.split(":")[1]))) return err("complete rollout ownership cannot resume ordinary HTTP requests");
  operations.forEach((operation) => { Object.freeze(operation.descriptor); Object.freeze(operation); });
  return ok(Object.freeze({ version: 1 as const, created: parsed.data.created, fence: fence.value, tickets: tickets.value, operations: Object.freeze(operations),
    ...(allocation === undefined ? {} : { registrationAllocation: Object.freeze(allocation) }),
    ...(receipt === undefined ? {} : { registrationReceipt: receipt }),
    ...(http?.ok ? { http: http.value } : {}),
    ...(rollout === undefined ? {} : { rollout }),
    ...(rollouts === undefined ? {} : { rollouts: Object.freeze(rollouts) }) }));
};
