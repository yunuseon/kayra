import { all, err, ok } from '../lib/result.ts';
import type { Overlap, ServiceRole } from './rollout.ts';

export type PlanService = {
  readonly role: ServiceRole;
  readonly overlap: Overlap;
  readonly image: string;
  readonly specification: string;
  readonly configuration: string;
  readonly secretGenerations: readonly string[];
  readonly dependencies: readonly string[];
  readonly volumes: readonly string[];
};
export type PlanVolume = { readonly identity: string; readonly runtimeName: string };
export type DeploymentPlan = {
  readonly version: 1;
  readonly app: string;
  readonly runtime: 'swarm';
  readonly configuration: string;
  readonly grants: { readonly maintenance: boolean; readonly memoryBytes: number; readonly nanoCpus: number };
  readonly volumes: Readonly<Record<string, PlanVolume>>;
  readonly services: Readonly<Record<string, PlanService>>;
};

const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const extra = (value: Readonly<Record<string, unknown>>, known: readonly string[]) => Object.keys(value).find((key) => !known.includes(key));
const name = (value: unknown): value is string => typeof value === 'string' && value.length <= 48 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const image = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const list = (value: unknown, predicate: (item: unknown) => item is string) => {
  if (!Array.isArray(value)) return undefined;
  const length = value.length;
  if (length > 128) return undefined;
  // Snapshot indexed own values before validation: array iterators and methods
  // on an untrusted input can produce different elements than those checked.
  const snapshot: readonly unknown[] = Array.from({ length }, (_, index) => {
    const item: unknown = Object.hasOwn(value, index) ? value[index] : undefined;
    return item;
  });
  if (!snapshot.every(predicate) || new Set(snapshot).size !== length) return undefined;
  return Object.freeze(snapshot.toSorted());
};
const secretGeneration = (value: unknown): value is string => typeof value === 'string' && /^sg_[a-f0-9]{32}$/.test(value);
const volumeIdentity = (value: unknown): value is string => typeof value === 'string' && /^vol_[a-f0-9]{32}$/.test(value);

const service = (key: string, value: unknown) => {
  if (!name(key) || !record(value)) return err(`service ${key}: invalid mapping or name`);
  const unknown = extra(value, ['role', 'overlap', 'image', 'specification', 'configuration', 'secretGenerations', 'dependencies', 'volumes']);
  if (unknown !== undefined) return err(`service ${key}: unsupported field ${unknown}`);
  const { role, overlap, image: ref, specification, configuration } = value;
  const secrets = list(value['secretGenerations'], secretGeneration);
  const dependencies = list(value['dependencies'], name);
  const volumes = list(value['volumes'], name);
  if (role !== 'http' && role !== 'worker' && role !== 'singleton' && role !== 'retained-dependency') return err(`service ${key}: invalid role`);
  if (overlap !== 'allowed' && overlap !== 'forbidden' && overlap !== 'coordinated') return err(`service ${key}: invalid overlap`);
  if (role === 'retained-dependency' && overlap !== 'forbidden') return err(`service ${key}: retained dependency must forbid overlap`);
  if (role === 'singleton' && overlap === 'allowed') return err(`service ${key}: singleton overlap must be coordinated`);
  if (overlap === 'coordinated' && role !== 'singleton') return err(`service ${key}: coordination is only supported for singletons`);
  if (!image(ref) || !digest(specification) || !digest(configuration) || secrets === undefined || dependencies === undefined || volumes === undefined) return err(`service ${key}: immutable image, specification and reference lists are required`);
  return ok<readonly [string, PlanService]>([key, Object.freeze({ role, overlap, image: ref, specification, configuration, secretGenerations: secrets, dependencies, volumes })]);
};

export const ownedVolumeName = (app: string, key: string, identity: string) => `kayra-${String(app.length)}-${app}-${String(key.length)}-${key}-${identity}`;

const volume = (app: string, key: string, value: unknown) => {
  if (!name(key) || !record(value)) return err(`volume ${key}: invalid mapping or name`);
  const unknown = extra(value, ['identity', 'runtimeName']);
  if (unknown !== undefined) return err(`volume ${key}: unsupported field ${unknown}`);
  const { identity, runtimeName } = value;
  if (!volumeIdentity(identity) || typeof runtimeName !== 'string' || runtimeName !== ownedVolumeName(app, key, identity)) return err(`volume ${key}: invalid owned identity or runtime name`);
  return ok<readonly [string, PlanVolume]>([key, Object.freeze({ identity, runtimeName })]);
};

/** Parse a deliberately narrow plan fragment; callers must verify hashes and ownership at admission. */
export const parseDeploymentPlan = (value: unknown) => {
  if (!record(value)) return err('plan must be a mapping');
  const unknown = extra(value, ['version', 'app', 'runtime', 'configuration', 'grants', 'volumes', 'services']);
  if (unknown !== undefined) return err(`plan: unsupported field ${unknown}`);
  const { version, app, runtime, configuration, grants, volumes, services } = value;
  if (version !== 1 || !name(app) || runtime !== 'swarm' || !digest(configuration)) return err('plan: invalid version, app, runtime or configuration identity');
  if (!record(grants) || extra(grants, ['maintenance', 'memoryBytes', 'nanoCpus']) !== undefined || typeof grants['maintenance'] !== 'boolean' || !positive(grants['memoryBytes']) || !positive(grants['nanoCpus'])) return err('plan: explicit valid grants and budgets are required');
  if (!record(volumes) || !record(services) || Object.keys(services).length === 0 || Object.keys(services).length > 128 || Object.keys(volumes).length > 128) return err('plan: bounded volumes and nonempty services must be mappings');
  const parsedVolumes = all(Object.entries(volumes).map(([key, item]) => volume(app, key, item)));
  const parsedServices = all(Object.entries(services).map(([key, item]) => service(key, item)));
  if (!parsedVolumes.ok) return parsedVolumes;
  if (!parsedServices.ok) return parsedServices;
  if (new Set(parsedVolumes.value.map(([, item]) => item.identity)).size !== parsedVolumes.value.length) return err('plan: duplicate volume identity');
  const volumeMap = Object.freeze(Object.fromEntries(parsedVolumes.value));
  const serviceMap = Object.freeze(Object.fromEntries(parsedServices.value));
  for (const [key, item] of parsedServices.value) {
    if (item.dependencies.some((dependency) => dependency === key || !Object.hasOwn(serviceMap, dependency))) return err(`service ${key}: invalid dependency`);
    if (item.volumes.some((reference) => !Object.hasOwn(volumeMap, reference))) return err(`service ${key}: unknown volume`);
  }
  const keys = Object.keys(serviceMap);
  const visited = keys.reduce<readonly string[]>(
    (seen) => Object.freeze([...new Set([...seen, ...keys.filter((key) => serviceMap[key]?.dependencies.every((dependency) => seen.includes(dependency)))])]),
    [],
  );
  if (visited.length !== keys.length) return err('plan: dependency cycle');
  return ok<DeploymentPlan>(Object.freeze({ version, app, runtime, configuration,
    grants: Object.freeze({ maintenance: grants['maintenance'], memoryBytes: grants['memoryBytes'], nanoCpus: grants['nanoCpus'] }), volumes: volumeMap, services: serviceMap }));
};

/** A retained dependency's full normalized identity must stay unchanged after creation. */
export const validateRetainedDependencies = (previous: DeploymentPlan, next: DeploymentPlan) => {
  if (previous.app !== next.app) return err('plan: app changed');
  for (const [key, item] of Object.entries(previous.services)) {
    if (item.role !== 'retained-dependency') continue;
    const candidate = next.services[key];
    if (candidate === undefined || JSON.stringify(item) !== JSON.stringify(candidate)) return err(`retained dependency ${key} changed`);
    for (const volumeName of item.volumes) {
      if (JSON.stringify(previous.volumes[volumeName]) !== JSON.stringify(next.volumes[volumeName])) return err(`retained dependency ${key}: volume ${volumeName} changed`);
    }
  }
  return ok(true);
};
