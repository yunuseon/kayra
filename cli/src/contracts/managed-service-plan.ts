import { createHash } from "node:crypto";
import { z } from "zod";
import { parseDataOwnership, ownedVolumeSchema } from "./owned-volume.ts";
import { parseServiceInputs } from "./service-inputs.ts";
import type { DataOwnership } from "./owned-volume.ts";
import type { ServiceInputs } from "./service-inputs.ts";
import { volumeMountTargetSchema } from "./managed-compose-description.ts";
import { err, ok } from "../lib/result.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const seconds = positive.max(300);
const serviceName = z.string().max(48).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const nativeId = z.string().regex(/^[a-z0-9]{25}$/);
const argument = z.string().max(4096).refine((value) => !value.includes("\0") && !value.includes("$"));
const words = z.array(argument).min(1).max(128).readonly().refine((value) => value[0] !== "");
const resources = z.object({ memoryBytes: positive, reserveMemoryBytes: positive, nanoCpus: positive, reserveNanoCpus: positive }).strict().readonly()
  .refine((value) => value.reserveMemoryBytes <= value.memoryBytes && value.reserveNanoCpus <= value.nanoCpus);
const health = z.object({ command: words, intervalSeconds: seconds, timeoutSeconds: seconds,
  startPeriodSeconds: z.number().int().min(0).max(300), retries: positive.max(100),
}).strict().readonly().refine((value) => value.timeoutSeconds <= value.intervalSeconds);
const mount = z.object({ volume: ownedVolumeSchema, createdAt: z.string().max(128).refine((value) => Number.isFinite(Date.parse(value))),
  target: volumeMountTargetSchema, readOnly: z.boolean(), noCopy: z.boolean(),
}).strict().readonly();
const shape = z.object({ version: z.literal(1), runtime: z.literal("swarm"), owner: z.unknown(), service: serviceName, nativeName: z.string(),
  role: z.enum(["http", "worker", "singleton", "retained-dependency"]), overlap: z.enum(["allowed", "forbidden", "coordinated"]),
  handoffCheck: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/).nullable(), image: z.string().max(512), inputs: z.unknown(),
  command: words.nullable(), entrypoint: words.nullable(), resources, health, stopGraceSeconds: seconds,
  host: z.object({ node: nativeId, cluster: nativeId, routingNetwork: nativeId.nullable() }).strict().readonly(),
  privateNetwork: z.object({ id: nativeId, name: z.string() }).strict().readonly(),
  mounts: z.array(mount).max(32).readonly(), dependencies: z.array(z.object({ service: serviceName, condition: z.enum(["started", "healthy"]) }).strict().readonly()).max(128).readonly(),
}).strict().readonly();
export type ManagedServicePlan = Omit<z.infer<typeof shape>, "owner" | "inputs"> & { readonly owner: DataOwnership; readonly inputs: ServiceInputs };

/** The full incarnation prevents a removed service's name barriers from targeting its replacement. */
const lexical = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
export const managedServiceName = (owner: Pick<DataOwnership, "app" | "incarnation">, service: string) =>
  "kayra-service-" + createHash("sha256").update(JSON.stringify({ app: owner.app, incarnation: owner.incarnation, service })).digest("hex").slice(0, 40);

/** Validates immutable runtime inputs; parsing is neither admission nor proof of volume creation. */
export const parseManagedServicePlan = (input: unknown) => {
  const checked = shape.safeParse(input); if (!checked.success) return err("invalid immutable managed service plan"); const value = checked.data;
  const owner = parseDataOwnership(value.owner); const inputs = parseServiceInputs(value.inputs);
  if (!owner.ok || !inputs.ok || owner.value.app.length > 48 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(owner.value.app) || inputs.value.registration.app !== owner.value.app || inputs.value.registration.incarnation !== owner.value.incarnation ||
    value.nativeName !== managedServiceName(owner.value, value.service) || value.privateNetwork.name !== `kayra-app-${owner.value.incarnation}` ||
    value.privateNetwork.id === value.host.routingNetwork || (value.role === "http" ? value.host.routingNetwork === null : value.host.routingNetwork !== null)) return err("invalid managed service authority references");
  if ((value.role === "retained-dependency" && value.overlap !== "forbidden") || (value.role === "singleton" && value.overlap === "allowed") ||
    (value.overlap === "coordinated" && value.role !== "singleton") || (value.role === "singleton" && value.overlap === "coordinated" ? value.handoffCheck === null : value.handoffCheck !== null)) return err("contradictory managed service overlap or handoff");
  const component = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
  if (!new RegExp(`^localhost:5000/${owner.value.app}/${component}(?:/${component})*@sha256:[a-f0-9]{64}$`).test(value.image)) return err("managed service requires an app-owned immutable image");
  if (value.mounts.some((item) => item.volume.app !== owner.value.app || item.volume.dataOwner !== owner.value.dataOwner) ||
    new Set(value.dependencies.map((item) => item.service)).size !== value.dependencies.length || value.dependencies.some((item) => item.service === value.service)) return err("invalid managed mounts or dependencies");
  if (value.mounts.some((item, index) => value.mounts.some((other, otherIndex) => index !== otherIndex &&
    (item.target === other.target || item.target.startsWith(`${other.target}/`) || other.target.startsWith(`${item.target}/`) ||
      item.volume.key === other.volume.key && item.volume.allocation !== other.volume.allocation || item.volume.allocation === other.volume.allocation && (item.createdAt !== other.createdAt || JSON.stringify(item.volume) !== JSON.stringify(other.volume)))))) return err("conflicting managed volume mounts");
  return ok<ManagedServicePlan>(Object.freeze({ ...value, owner: owner.value,
    inputs: Object.freeze({ ...inputs.value, environment: Object.freeze(Object.fromEntries(Object.entries(inputs.value.environment).sort(([left], [right]) => lexical(left, right)))) }),
    mounts: Object.freeze(value.mounts.toSorted((left, right) => lexical(left.target, right.target))),
    dependencies: Object.freeze(value.dependencies.toSorted((left, right) => lexical(left.service, right.service))),
  }));
};

export const managedServiceDigest = (input: ManagedServicePlan) => {
  const checked = parseManagedServicePlan(input); if (!checked.ok) throw new Error(checked.error);
  return createHash("sha256").update(JSON.stringify(checked.value)).digest("hex");
};
