import { all, err, ok } from "../lib/result.ts";

/** These data contracts have no dependency on a server implementation or runtime effects. */
export type Runtime = "compose" | "swarm";
export type ServiceRole = "http" | "worker" | "singleton" | "retained-dependency";
export type Overlap = "allowed" | "forbidden" | "coordinated";
export type Capability = "rolling-http" | "workers" | "singleton" | "coordinated-non-singleton" | "retained-dependency" | "migrations" | "checks" | "maintenance";
export type Service = {
  readonly role: ServiceRole;
  readonly overlap: Overlap;
  readonly handoff_check?: string;
};
export type Command = {
  readonly service: string;
  readonly command: readonly string[];
  readonly timeout_seconds: number;
};
export type Migration = Command & {
  readonly id: string;
  readonly recovery: { readonly kind: "replay-safe" } | { readonly kind: "status-probe"; readonly command: readonly string[]; readonly timeout_seconds: number };
};
export type Check = Command & { readonly id: string };
export type Rollout = {
  readonly strategy: "rolling" | "maintenance";
  readonly mixed_version_compatible: boolean;
  readonly rollback_compatible: boolean;
  readonly services: Readonly<Record<string, Service>>;
  readonly migrations: readonly Migration[];
  readonly checks: readonly Check[];
};

const record = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
const name = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const seconds = (value: unknown): value is number => positive(value) && value <= Math.floor(Number.MAX_SAFE_INTEGER / 1000);
// Copy only own indexed entries, without trusting an input array's iterator.
const dense = (value: unknown): readonly unknown[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const length = value.length;
  if (length > 4096) return undefined;
  // eslint-disable-next-line functional/prefer-immutable-types -- build a bounded snapshot without trusting the input iterator
  const copy: unknown[] = [];
  // eslint-disable-next-line functional/no-let -- inspect every own index, including holes
  for (let i = 0; i < length; i++) {
    if (!Object.hasOwn(value, i)) return undefined;
    // eslint-disable-next-line functional/immutable-data -- local snapshot, never the input
    copy.push(value[i]);
  }
  return value.length === length ? copy : undefined;
};
const args = (value: unknown): readonly string[] | undefined => {
  const copy = dense(value);
  return copy !== undefined && copy.length > 0 && copy.every((part): part is string => typeof part === "string" && part.length > 0 && !part.includes("\0")) ? Object.freeze(copy) : undefined;
};
const extra = (value: Readonly<Record<string, unknown>>, keys: readonly string[]) => Object.keys(value).find((key) => !keys.includes(key));

export const parseRuntime = (value: unknown) => value === undefined || value === "compose" ? ok<Runtime>("compose") : value === "swarm" ? ok<Runtime>("swarm") : err("runtime must be compose or swarm");

const service = (value: unknown, key: string) => {
  if (!name(key) || !record(value)) return err(`service ${key}: invalid name or mapping`);
  const unknown = extra(value, ["role", "overlap", "handoff_check"]);
  if (unknown !== undefined) return err(`service ${key}: unknown field ${unknown}`);
  const { role, overlap, handoff_check: handoff } = value;
  if (role !== "http" && role !== "worker" && role !== "singleton" && role !== "retained-dependency") return err(`service ${key}: invalid role`);
  if (overlap !== "allowed" && overlap !== "forbidden" && overlap !== "coordinated") return err(`service ${key}: invalid overlap`);
  if (handoff !== undefined && !name(handoff)) return err(`service ${key}: invalid handoff check`);
  if (role === "singleton" && overlap === "allowed") return err(`service ${key}: a singleton cannot overlap without app coordination`);
  if (role === "retained-dependency" && overlap !== "forbidden") return err(`service ${key}: a retained dependency cannot overlap`);
  if (role !== "singleton" && handoff !== undefined) return err(`service ${key}: handoff check requires a singleton`);
  if (role === "singleton" && overlap === "coordinated" && handoff === undefined) return err(`service ${key}: coordinated singleton needs a handoff check`);
  return ok<readonly [string, Service]>([key, { role, overlap, ...(handoff === undefined ? {} : { handoff_check: handoff }) }]);
};

const command = (value: Readonly<Record<string, unknown>>, label: string) => {
  const target = value["service"];
  const argv = args(value["command"]);
  const timeout = value["timeout_seconds"];
  if (!name(target) || argv === undefined || !seconds(timeout)) return err(`${label}: service, command, and valid timeout_seconds are required`);
  return ok<Command>({ service: target, command: argv, timeout_seconds: timeout });
};

const migration = (value: unknown, index: number) => {
  const label = `migration ${String(index)}`;
  if (!record(value) || !name(value["id"])) return err(`${label}: invalid mapping or id`);
  const unknown = extra(value, ["id", "service", "command", "timeout_seconds", "recovery"]);
  if (unknown !== undefined) return err(`${label}: unknown field ${unknown}`);
  const parsed = command(value, label);
  if (!parsed.ok) return parsed;
  const recovery = value["recovery"];
  if (!record(recovery)) return err(`${label}: recovery is required`);
  if (recovery["kind"] === "replay-safe") {
    if (extra(recovery, ["kind"]) !== undefined) return err(`${label}: unknown recovery field`);
    return ok<Migration>({ id: value["id"], ...parsed.value, recovery: { kind: "replay-safe" } });
  }
  if (recovery["kind"] === "status-probe") {
    const argv = args(recovery["command"]);
    if (extra(recovery, ["kind", "command", "timeout_seconds"]) !== undefined || argv === undefined || !seconds(recovery["timeout_seconds"])) return err(`${label}: invalid status probe`);
    return ok<Migration>({ id: value["id"], ...parsed.value, recovery: { kind: "status-probe", command: argv, timeout_seconds: recovery["timeout_seconds"] } });
  }
  return err(`${label}: recovery must be replay-safe or status-probe`);
};

const check = (value: unknown, index: number) => {
  const label = `check ${String(index)}`;
  if (!record(value) || !name(value["id"])) return err(`${label}: invalid mapping or id`);
  const unknown = extra(value, ["id", "service", "command", "timeout_seconds"]);
  if (unknown !== undefined) return err(`${label}: unknown field ${unknown}`);
  const parsed = command(value, label);
  return parsed.ok ? ok<Check>({ id: value["id"], ...parsed.value }) : parsed;
};

/** Validate untrusted rollout metadata at each boundary. No Compose service is inferred here. */
export const parseRollout = (value: unknown) => {
  if (!record(value)) return err("rollout must be a mapping");
  const unknown = extra(value, ["strategy", "mixed_version_compatible", "rollback_compatible", "services", "migrations", "checks"]);
  if (unknown !== undefined) return err(`rollout: unknown field ${unknown}`);
  const { strategy, mixed_version_compatible: mixed, rollback_compatible: rollback, services } = value;
  const migrations = value["migrations"] === undefined ? [] : value["migrations"];
  const checks = value["checks"] === undefined ? [] : value["checks"];
  if (strategy !== "rolling" && strategy !== "maintenance") return err("rollout: invalid strategy");
  if (typeof mixed !== "boolean" || typeof rollback !== "boolean") return err("rollout: explicit compatibility declarations are required");
  if (strategy === "rolling" && (!mixed || !rollback)) return err("rollout: rolling requires mixed-version and rollback compatibility");
  if (!record(services) || Object.keys(services).length === 0) return err("rollout: services must be a nonempty mapping");
  const migrationEntries = dense(migrations);
  const checkEntries = dense(checks);
  if (migrationEntries === undefined || checkEntries === undefined) return err("rollout: migrations and checks must be dense lists of at most 4096 entries");
  const parsedServices = all(Object.entries(services).map(([key, entry]) => service(entry, key)));
  const parsedMigrations = all(migrationEntries.map(migration));
  const parsedChecks = all(checkEntries.map(check));
  if (!parsedServices.ok) return parsedServices;
  if (!parsedMigrations.ok) return parsedMigrations;
  if (!parsedChecks.ok) return parsedChecks;
  const roles = Object.fromEntries(parsedServices.value);
  if (strategy === "rolling" && parsedServices.value.some(([, spec]) => spec.role === "http" && spec.overlap !== "allowed")) return err("rollout: rolling HTTP services require allowed overlap");
  if (new Set(parsedMigrations.value.map((item) => item.id)).size !== parsedMigrations.value.length) return err("rollout: duplicate migration id");
  if (new Set(parsedChecks.value.map((item) => item.id)).size !== parsedChecks.value.length) return err("rollout: duplicate check id");
  if (parsedMigrations.value.some((item) => !Object.hasOwn(roles, item.service) || roles[item.service]?.role === "retained-dependency")) return err("rollout: migrations must reference an app-image service");
  if (parsedChecks.value.some((item) => !Object.hasOwn(roles, item.service) || roles[item.service]?.role === "retained-dependency")) return err("rollout: checks must reference an app-image service");
  if (parsedServices.value.some(([key, spec]) => spec.handoff_check !== undefined && !parsedChecks.value.some((item) => item.id === spec.handoff_check && item.service === key))) return err("rollout: singleton handoff check must run in its service");
  const immutableServices = Object.freeze(Object.fromEntries(parsedServices.value.map(([key, spec]) => [key, Object.freeze({ ...spec })] as const)));
  const immutableMigrations = Object.freeze(parsedMigrations.value.map((item) => Object.freeze({ ...item, command: Object.freeze([...item.command]), recovery: Object.freeze(item.recovery.kind === "status-probe" ? { ...item.recovery, command: Object.freeze([...item.recovery.command]) } : { ...item.recovery }) })));
  const immutableChecks = Object.freeze(parsedChecks.value.map((item) => Object.freeze({ ...item, command: Object.freeze([...item.command]) })));
  return ok<Rollout>(Object.freeze({ strategy, mixed_version_compatible: mixed, rollback_compatible: rollback, services: immutableServices, migrations: immutableMigrations, checks: immutableChecks }));
};

/** Validate fleet authorization and adapter capability before producing any runtime effects. */
export const validateAdmission = (options: {
  readonly runtime: Runtime;
  readonly swarmEnabled: boolean;
  readonly maintenanceGranted: boolean;
  readonly existingRuntime?: Runtime;
  readonly capabilities: readonly Capability[];
  readonly rollout: Rollout | undefined;
  readonly composeServices: readonly string[];
  readonly routedServices: readonly string[];
  readonly migrationTimeoutCeilingSeconds: number;
  readonly checkTimeoutCeilingSeconds?: number;
}) => {
  if (options.existingRuntime !== undefined && options.existingRuntime !== options.runtime) return err("changing the runtime of a managed app is not supported");
  if (options.runtime === "compose") return options.rollout === undefined ? ok(true) : err("rollout metadata requires an experimental runtime");
  if (!options.swarmEnabled) return err("Swarm is not enabled on this server");
  if (options.rollout === undefined) return err("Swarm requires rollout metadata");
  const rollout = options.rollout;
  if (rollout.strategy === "maintenance" && !options.maintenanceGranted) return err("maintenance deployments are not granted for this app");
  if (!seconds(options.migrationTimeoutCeilingSeconds)) return err("a valid migration timeout ceiling is required");
  const checkTimeoutCeilingSeconds = options.checkTimeoutCeilingSeconds;
  if (!seconds(checkTimeoutCeilingSeconds)) return err("a valid check timeout ceiling is required");
  if (rollout.migrations.some((step) => step.timeout_seconds > options.migrationTimeoutCeilingSeconds || (step.recovery.kind === "status-probe" && step.recovery.timeout_seconds > options.migrationTimeoutCeilingSeconds))) return err("migration or status probe timeout exceeds the server ceiling");
  if (rollout.checks.some((step) => step.timeout_seconds > checkTimeoutCeilingSeconds)) return err("check timeout exceeds the server ceiling");
  const needed: readonly Capability[] = [
    ...(rollout.strategy === "maintenance" ? ["maintenance" as const] : []),
    ...(Object.values(rollout.services).some((item) => item.role === "http") && rollout.strategy === "rolling" ? ["rolling-http" as const] : []),
    ...(Object.values(rollout.services).some((item) => item.role === "worker") ? ["workers" as const] : []),
    ...(Object.values(rollout.services).some((item) => item.role === "singleton") ? ["singleton" as const] : []),
    ...(Object.values(rollout.services).some((item) => item.overlap === "coordinated" && item.role !== "singleton") ? ["coordinated-non-singleton" as const] : []),
    ...(Object.values(rollout.services).some((item) => item.role === "retained-dependency") ? ["retained-dependency" as const] : []),
    ...(rollout.migrations.length > 0 ? ["migrations" as const] : []),
    ...(rollout.checks.length > 0 ? ["checks" as const] : []),
  ];
  const unsupported = needed.find((capability) => !options.capabilities.includes(capability));
  if (unsupported !== undefined) return err(`runtime does not support ${unsupported}`);
  const declared = Object.keys(rollout.services);
  if (declared.length !== options.composeServices.length || declared.some((item) => !options.composeServices.includes(item))) return err("every Compose service must have exactly one rollout declaration");
  if (options.routedServices.some((item) => rollout.services[item]?.role !== "http")) return err("routes must refer to HTTP services");
  return ok(true);
};
