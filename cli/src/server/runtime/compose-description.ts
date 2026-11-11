import { parseDocument } from "yaml";
import { all, err, ok } from "../../lib/result.ts";
import type { ComposeDescription, DescribedService, DescriptionFile, ServiceHealth, ServiceResources } from "../../contracts/compose-description.ts";

const record = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
const extra = (value: Readonly<Record<string, unknown>>, allowed: readonly string[]) => Object.keys(value).find((key) => !allowed.includes(key));
const name = (value: string) => value.length <= 48 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const maximum = 256 * 1024;

const memory = (value: unknown) => {
  if (positive(value)) return value;
  if (typeof value !== "string") return undefined;
  const match = /^([0-9]+)(b|k|kb|m|mb|g|gb|t|tb)?$/i.exec(value);
  if (match?.[1] === undefined) return undefined;
  const unit = (match[2] ?? "b").toLowerCase()[0] ?? "b";
  const exponent = ["b", "k", "m", "g", "t"].indexOf(unit);
  const bytes = Number(match[1]) * 1024 ** exponent;
  return positive(bytes) ? bytes : undefined;
};
const cpus = (value: unknown) => {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const match = /^([0-9]+)(?:\.([0-9]{1,9}))?$/.exec(String(value));
  if (match?.[1] === undefined) return undefined;
  const nanos = Number(match[1]) * 1_000_000_000 + Number((match[2] ?? "").padEnd(9, "0"));
  return positive(nanos) ? nanos : undefined;
};
const seconds = (value: unknown, fallback: number) => {
  if (value === undefined) return fallback;
  if (typeof value !== "string") return undefined;
  const match = /^([0-9]+)(ms|s|m|h)$/.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const factor = match[2] === "ms" ? 0.001 : match[2] === "s" ? 1 : match[2] === "m" ? 60 : 3600;
  const result = Number(match[1]) * factor;
  return Number.isSafeInteger(result) && result >= 0 && result <= 300 ? result : undefined;
};
const words = (value: unknown) => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128 || typeof value[0] !== "string" || value[0] === "" ||
    !value.every((word: unknown): word is string => typeof word === "string" && word.length <= 4096 && !word.includes("\0") && !word.includes("$"))) return undefined;
  return Object.freeze(value.map((word: string) => word));
};
const argv = (value: unknown) => value === undefined || value === null ? null : words(value);

const resources = (value: unknown) => {
  if (!record(value) || extra(value, ["resources", "mode", "replicas"]) !== undefined ||
    (value["mode"] !== undefined && value["mode"] !== "replicated") || (value["replicas"] !== undefined && value["replicas"] !== 1)) return err("only one replicated service instance and explicit resource budgets are supported");
  const resources = value["resources"];
  if (!record(resources) || extra(resources, ["limits", "reservations"]) !== undefined) return err("explicit resource limits and reservations are required");
  const limits = resources["limits"];
  const reservations = resources["reservations"];
  if (!record(limits) || !record(reservations) || extra(limits, ["memory", "cpus"]) !== undefined || extra(reservations, ["memory", "cpus"]) !== undefined) return err("only CPU and memory resource budgets are supported");
  const memoryBytes = memory(limits["memory"]);
  const reserveMemoryBytes = memory(reservations["memory"]);
  const nanoCpus = cpus(limits["cpus"]);
  const reserveNanoCpus = cpus(reservations["cpus"]);
  if (memoryBytes === undefined || reserveMemoryBytes === undefined || nanoCpus === undefined || reserveNanoCpus === undefined || reserveMemoryBytes > memoryBytes || reserveNanoCpus > nanoCpus) return err("valid explicit CPU/memory limits and reservations are required");
  return ok<ServiceResources>(Object.freeze({ memoryBytes, reserveMemoryBytes, nanoCpus, reserveNanoCpus }));
};
const health = (value: unknown) => {
  if (!record(value) || extra(value, ["test", "interval", "timeout", "start_period", "retries", "disable"]) !== undefined || (value["disable"] !== undefined && value["disable"] !== false)) return err("a declared CMD health check is required");
  const test = value["test"];
  if (!Array.isArray(test) || test[0] !== "CMD") return err("only explicit CMD health checks are supported");
  const command = words(test.slice(1));
  const intervalSeconds = seconds(value["interval"], 30);
  const timeoutSeconds = seconds(value["timeout"], 30);
  const startPeriodSeconds = seconds(value["start_period"], 0);
  const retries = value["retries"] ?? 3;
  if (command === undefined || intervalSeconds === undefined || intervalSeconds < 1 || timeoutSeconds === undefined || timeoutSeconds < 1 || timeoutSeconds > intervalSeconds || startPeriodSeconds === undefined || !positive(retries) || retries > 100) return err("invalid health-check timings or arguments");
  return ok<ServiceHealth>(Object.freeze({ command, intervalSeconds, timeoutSeconds, startPeriodSeconds, retries }));
};
const environment = (value: unknown) => {
  if (value === undefined) return ok<Readonly<Record<string, string>>>(Object.freeze({}));
  if (!record(value) || Object.keys(value).length > 128) return err("environment must explicitly map names to strings");
  const entries = Object.entries(value);
  if (!entries.every((entry): entry is [string, string] => /^[A-Z][A-Z0-9_]{0,127}$/.test(entry[0]) && typeof entry[1] === "string" && entry[1].length <= 65536 && !entry[1].includes("\0"))) return err("environment must explicitly map names to strings");
  return ok<Readonly<Record<string, string>>>(Object.freeze(Object.fromEntries(entries)));
};
const service = (key: string, value: unknown) => {
  if (!name(key) || !record(value)) return err("invalid Compose service name or mapping");
  const unsupported = extra(value, ["image", "environment", "command", "entrypoint", "healthcheck", "stop_grace_period", "deploy", "networks"]);
  if (unsupported !== undefined) return err(`service ${key}: unsupported Compose field ${unsupported}`);
  const network = value["networks"];
  if (network !== undefined && !(Array.isArray(network) && network.length === 1 && network[0] === "default") &&
    !(record(network) && Object.keys(network).length === 1 && Object.hasOwn(network, "default") && (network["default"] === null || (record(network["default"]) && Object.keys(network["default"]).length === 0)))) return err("only the implicit app network is supported");
  const image = value["image"];
  const env = environment(value["environment"]);
  const budget = resources(value["deploy"]);
  const check = health(value["healthcheck"]);
  const stopGraceSeconds = seconds(value["stop_grace_period"], 30);
  const command = argv(value["command"]);
  const entrypoint = argv(value["entrypoint"]);
  if (typeof image !== "string" || image.length > 512 || image.includes("\0")) return err("a declared image reference is required");
  if (!env.ok) return env;
  if (!budget.ok) return budget;
  if (!check.ok) return check;
  if (stopGraceSeconds === undefined || stopGraceSeconds < 1 || command === undefined || entrypoint === undefined) return err("explicit command/entrypoint argument lists and valid shutdown grace are required");
  return ok<readonly [string, DescribedService]>(Object.freeze([key, Object.freeze({ image, environment: env.value, resources: budget.value, health: check.value, stopGraceSeconds, command, entrypoint })]));
};

/** A deliberately narrow Compose subset; no interpolation, host reads or Docker effects. */
export const describeCompose = (files: readonly DescriptionFile[]) => {
  if (files.length !== 1) return err("experimental HTTP currently requires exactly one Compose file");
  const file = files[0];
  if (file === undefined || Buffer.byteLength(file.content, "utf8") > maximum || file.path === "" || file.path.startsWith("/") || file.path.split("/").some((part) => part === ".." || part === "")) return err("invalid Compose artifact file");
  try {
    const document = parseDocument(file.content, { uniqueKeys: true, strict: true, merge: true });
    if (document.errors.length !== 0 || document.warnings.length !== 0) return err("invalid Compose YAML");
    const root: unknown = document.toJS({ maxAliasCount: 100 });
    if (!record(root)) return err("Compose must be a mapping");
    const unsupported = extra(root, ["services", "networks"]);
    if (unsupported !== undefined) return err(`unsupported Compose field ${unsupported}`);
    const networks = root["networks"];
    if (networks !== undefined && !(record(networks) && Object.keys(networks).length === 1 && record(networks["default"]) && Object.keys(networks["default"]).length === 0)) return err("custom Compose networks are not supported");
    const services = root["services"];
    if (!record(services) || Object.keys(services).length === 0 || Object.keys(services).length > 128) return err("Compose services must be a bounded nonempty mapping");
    const parsed = all(Object.entries(services).map(([key, definition]) => service(key, definition)));
    return parsed.ok ? ok<ComposeDescription>(Object.freeze({ services: Object.freeze(Object.fromEntries(parsed.value)) })) : parsed;
  } catch {
    return err("invalid or excessively aliased Compose YAML");
  }
};
