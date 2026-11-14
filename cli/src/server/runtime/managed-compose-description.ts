import type { DescriptionFile } from "../../contracts/compose-description.ts";
import type { DeclaredVolumeMount, ManagedComposeDescription, ServiceDependency } from "../../contracts/managed-compose-description.ts";
import { all, err, ok } from "../../lib/result.ts";
import { describeComposeMapping, readComposeDocument } from "./compose-description.ts";

const record = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
const only = (value: Readonly<Record<string, unknown>>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));
const volumeKey = (value: string) => /^[a-z][a-z0-9_-]{0,62}$/.test(value);
const targetPath = (value: unknown): value is string => typeof value === "string" && value.length <= 1024 && value.startsWith("/") &&
  // eslint-disable-next-line no-control-regex -- control bytes cannot be canonical mount path characters
  value.split("/").slice(1).every((part) => part !== "" && part !== "." && part !== "..") && !/[\x00-\x20\x7f:$\\]/.test(value) &&
  !["/proc", "/sys", "/dev"].some((path) => value === path || value.startsWith(`${path}/`));
const mount = (value: unknown, declared: readonly string[]) => {
  const definition = typeof value === "string" ? (() => {
    const parts = value.split(":");
    return parts.length === 2 || (parts.length === 3 && (parts[2] === "ro" || parts[2] === "rw")) ?
      Object.freeze({ type: "volume", source: parts[0], target: parts[1], read_only: parts[2] === "ro" }) : null;
  })() : value;
  if (!record(definition) || !only(definition, ["type", "source", "target", "read_only", "volume"]) || definition["type"] !== "volume" ||
    typeof definition["source"] !== "string" || !declared.includes(definition["source"]) || !targetPath(definition["target"]) ||
    (definition["read_only"] !== undefined && typeof definition["read_only"] !== "boolean")) return err("only declared named-volume mounts with canonical absolute targets are supported");
  const options = definition["volume"];
  if (options !== undefined && (!record(options) || !only(options, ["nocopy"]) || (options["nocopy"] !== undefined && typeof options["nocopy"] !== "boolean"))) return err("only the named-volume nocopy option is supported");
  return ok<DeclaredVolumeMount>(Object.freeze({ volume: definition["source"], target: definition["target"], readOnly: definition["read_only"] === true, noCopy: record(options) && options["nocopy"] === true }));
};
const mounts = (value: unknown, declared: readonly string[]) => {
  if (value === undefined) return ok<readonly DeclaredVolumeMount[]>(Object.freeze([]));
  if (!Array.isArray(value) || value.length > 32) return err("service volumes must be a bounded mount list");
  const parsed = all(value.map((item: unknown) => mount(item, declared)));
  if (!parsed.ok) return parsed;
  if (parsed.value.some((item, index) => parsed.value.some((other, otherIndex) => index !== otherIndex &&
    (item.target === other.target || item.target.startsWith(`${other.target}/`) || other.target.startsWith(`${item.target}/`))))) return err("overlapping mount targets are unsupported");
  return parsed;
};
const dependencies = (value: unknown) => {
  if (value === undefined) return ok<readonly ServiceDependency[]>(Object.freeze([]));
  if (Array.isArray(value)) {
    if (value.length > 128 || !value.every((item: unknown): item is string => typeof item === "string") || new Set(value).size !== value.length) return err("invalid dependency list");
    return ok<readonly ServiceDependency[]>(Object.freeze(value.map((service: string) => Object.freeze({ service, condition: "started" }))));
  }
  if (!record(value) || Object.keys(value).length > 128) return err("invalid dependency mapping");
  return all(Object.entries(value).map(([service, definition]) => {
    if (!record(definition) || !only(definition, ["condition", "required", "restart"]) ||
      (definition["required"] !== undefined && definition["required"] !== true) || (definition["restart"] !== undefined && definition["restart"] !== false) ||
      (definition["condition"] !== "service_started" && definition["condition"] !== "service_healthy")) return err("dependencies require started/healthy conditions without optional or cascading restarts");
    return ok<ServiceDependency>(Object.freeze({ service, condition: definition["condition"] === "service_healthy" ? "healthy" : "started" }));
  }));
};

/** Describes declarations only; does not select a runtime or allocate platform resources. */
export const describeManagedCompose = (files: readonly DescriptionFile[]) => {
  const parsed = readComposeDocument(files);
  if (!parsed.ok) return parsed;
  const root = parsed.value;
  if (!only(root, ["services", "networks", "volumes"])) return err("unsupported managed Compose field");
  const declarations = root["volumes"] ?? {};
  if (!record(declarations) || Object.keys(declarations).length > 32 || Object.entries(declarations).some(([key, value]) =>
    !volumeKey(key) || (value !== null && (!record(value) || Object.keys(value).length !== 0)))) return err("volumes must be plain logical declarations; external names and driver options are unsupported");
  const declared = Object.freeze(Object.keys(declarations).sort());
  const services = root["services"];
  if (!record(services)) return err("Compose services must be a mapping");
  const extensions = all(Object.entries(services).map(([key, value]) => {
    if (!record(value)) return err("invalid service mapping");
    const mounted = mounts(value["volumes"], declared); const depends = dependencies(value["depends_on"]);
    if (!mounted.ok) return mounted;
    if (!depends.ok) return depends;
    return ok(Object.freeze({ key, base: Object.freeze(Object.fromEntries(Object.entries(value).filter(([field]) => field !== "volumes" && field !== "depends_on"))), mounts: mounted.value, dependencies: depends.value }));
  }));
  if (!extensions.ok) return extensions;
  const base = describeComposeMapping(Object.freeze({ ...Object.fromEntries(Object.entries(root).filter(([key]) => key !== "services" && key !== "volumes")),
    services: Object.freeze(Object.fromEntries(extensions.value.map((service) => [service.key, service.base] as const))) }));
  if (!base.ok) return base;
  const edges = extensions.value;
  if (edges.some((item) => item.dependencies.some((dependency) => !Object.hasOwn(services, dependency.service)))) return err("dependency references an undeclared service");
  const settled = edges.reduce<readonly string[]>((ready) => Object.freeze([...ready,
    ...edges.filter((item) => !ready.includes(item.key) && item.dependencies.every((dependency) => ready.includes(dependency.service))).map((item) => item.key),
  ]), Object.freeze([]));
  if (settled.length !== edges.length) return err("dependency cycles are unsupported");
  if (declared.some((key) => !edges.some((item) => item.mounts.some((mounted) => mounted.volume === key)))) return err("unused volume declarations are unsupported");
  return ok<ManagedComposeDescription>(Object.freeze({ volumes: declared, services: Object.freeze(Object.fromEntries(edges.map((item) => {
    const service = base.value.services[item.key];
    if (service === undefined) throw new Error("validated service disappeared");
    return [item.key, Object.freeze({ ...service, mounts: item.mounts, dependencies: item.dependencies })] as const;
  }))) }));
};
