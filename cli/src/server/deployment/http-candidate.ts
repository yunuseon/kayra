import { err, ok } from '../../lib/result.ts';

/**
 * Disconnected experiment for one stateless HTTP service. This does not parse
 * Compose, admit a release, retain a plan, authenticate an authority or make
 * anything safe to persist or log: health arguments can contain secret values.
 * A caller must prove normalization omitted nothing.
 * Secrets, volumes and every unspecified feature are deliberately unsupported.
 * Async grant revocation and registration generation fencing are not modeled.
 */
type Resources = { readonly memoryBytes: number; readonly reserveMemoryBytes: number; readonly nanoCpus: number; readonly reserveNanoCpus: number };
type Health = { readonly command: readonly string[]; readonly intervalSeconds: number; readonly timeoutSeconds: number; readonly startPeriodSeconds: number; readonly retries: number };
type Route = { readonly host: string; readonly port: number; readonly check: string };
type Input = { readonly app: string; readonly service: string; readonly commit: string; readonly image: string; readonly strategy: 'rolling'; readonly mixedVersionCompatible: true; readonly rollbackCompatible: true; readonly resources: Resources; readonly health: Health; readonly stopGraceSeconds: number; readonly route: Route };

/** Supplied by platform-owned code, never by a bundle; both calls are read-only. */
export type HttpCandidateAuthority = {
  /** Return the current trusted registration and platform policy for this app. */
  readonly registration: (app: string) => Promise<unknown>;
  /** Verify the exact image and digest as the artifact of this app, service and commit. */
  readonly verifyImage: (request: Readonly<{ app: string; service: string; commit: string; image: string }>) => Promise<boolean>;
};
type Registration = { readonly app: string; readonly runtime: 'swarm'; readonly swarmEnabled: true; readonly hosts: readonly string[]; readonly maxMemoryBytes: number; readonly maxNanoCpus: number; readonly network: { readonly name: string; readonly id: string } };
const object = (x: unknown): x is Readonly<Record<string, unknown>> => typeof x === 'object' && x !== null && !Array.isArray(x);
const exact = (x: Readonly<Record<string, unknown>>, keys: readonly string[]) => Object.keys(x).length === keys.length && Object.keys(x).every((key) => keys.includes(key));
const name = (x: unknown): x is string => typeof x === 'string' && x.length <= 48 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(x);
const host = (x: unknown): x is string => typeof x === 'string' && x.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(x);
const positive = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x > 0;
const integer = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const words = (x: unknown): x is readonly string[] => Array.isArray(x) && x.length > 0 && x.length <= 128 && typeof x[0] === 'string' && x[0].length > 0 && x.every((part: unknown) => typeof part === 'string' && part.length <= 4096 && !part.includes('\0'));
const image = (x: unknown): x is string => {
  if (typeof x !== 'string' || x.length > 512) return false;
  const match = /^([^/]+)\/([^@]+)@sha256:[a-f0-9]{64}$/.exec(x);
  if (match?.[1] === undefined || match[2] === undefined) return false;
  if (`${match[1]}/${match[2]}`.length > 255) return false;
  const registry = match[1].split(':');
  const hostname = registry[0];
  const port = registry[1];
  if (hostname === undefined || registry.length > 2 || hostname.length > 253 || !hostname.split('.').every((part) => part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) return false;
  if (hostname !== 'localhost' && !hostname.includes('.') && port === undefined) return false;
  if (port !== undefined && (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535)) return false;
  return match[2].split('/').every((part) => /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(part));
};
const copy = (value: unknown) => { try { return structuredClone(value); } catch { return undefined; } };

const parseInput = (value: unknown) => {
  if (!object(value) || !exact(value, ['app', 'service', 'commit', 'image', 'strategy', 'mixedVersionCompatible', 'rollbackCompatible', 'resources', 'health', 'stopGraceSeconds', 'route'])) return err('invalid candidate fields');
  const { app, service, commit, image: ref, strategy, mixedVersionCompatible, rollbackCompatible, resources, health, stopGraceSeconds, route } = value;
  if (!name(app) || !name(service) || `kayra-${app}--${service}`.length > 63 || typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit) || !image(ref)) return err('invalid candidate identity');
  if (ref.split('/')[1] !== app || ref.split('/').length < 3) return err('image is outside the app namespace');
  if (strategy !== 'rolling' || mixedVersionCompatible !== true || rollbackCompatible !== true) return err('rolling compatibility is required');
  if (!object(resources) || !exact(resources, ['memoryBytes', 'reserveMemoryBytes', 'nanoCpus', 'reserveNanoCpus'])) return err('invalid resources');
  const { memoryBytes, reserveMemoryBytes, nanoCpus, reserveNanoCpus } = resources;
  if (!positive(memoryBytes) || !positive(reserveMemoryBytes) || reserveMemoryBytes > memoryBytes || !positive(nanoCpus) || !positive(reserveNanoCpus) || reserveNanoCpus > nanoCpus) return err('invalid resource limits');
  if (!object(health) || !exact(health, ['command', 'intervalSeconds', 'timeoutSeconds', 'startPeriodSeconds', 'retries'])) return err('invalid health fields');
  const { command, intervalSeconds, timeoutSeconds, startPeriodSeconds, retries } = health;
  if (!words(command) || !positive(intervalSeconds) || intervalSeconds > 300 || !positive(timeoutSeconds) || timeoutSeconds > intervalSeconds || !integer(startPeriodSeconds) || startPeriodSeconds > 300 || !positive(retries) || retries > 100) return err('invalid health check');
  if (!positive(stopGraceSeconds) || stopGraceSeconds > 300) return err('invalid shutdown grace');
  if (!object(route) || !exact(route, ['host', 'port', 'check']) || !host(route['host']) || !positive(route['port']) || route['port'] > 65535 || typeof route['check'] !== 'string' || route['check'].length > 2048 || !/^\/[A-Za-z0-9._~%/-]*$/.test(route['check'])) return err('invalid route');
  return ok<Input>({ app, service, commit, image: ref, strategy, mixedVersionCompatible, rollbackCompatible, resources: { memoryBytes, reserveMemoryBytes, nanoCpus, reserveNanoCpus }, health: { command: Object.freeze([...command]), intervalSeconds, timeoutSeconds, startPeriodSeconds, retries }, stopGraceSeconds, route: { host: route['host'], port: route['port'], check: route['check'] } });
};

const parseRegistration = (value: unknown, expected: string) => {
  if (!object(value) || !exact(value, ['app', 'runtime', 'swarmEnabled', 'hosts', 'maxMemoryBytes', 'maxNanoCpus', 'network']) || value['app'] !== expected || value['runtime'] !== 'swarm' || value['swarmEnabled'] !== true) return err('registration does not authorize Swarm');
  const { hosts, maxMemoryBytes, maxNanoCpus, network } = value;
  if (!Array.isArray(hosts) || hosts.length < 1 || hosts.length > 128 || !hosts.every(host) || new Set(hosts).size !== hosts.length || !positive(maxMemoryBytes) || !positive(maxNanoCpus)) return err('invalid registration grants');
  if (!object(network) || !exact(network, ['name', 'id']) || !name(network['name']) || typeof network['id'] !== 'string' || !/^[a-z0-9]{25}$/.test(network['id'])) return err('invalid platform network');
  return ok<Registration>({ app: expected, runtime: 'swarm', swarmEnabled: true, hosts: Object.freeze([...hosts]), maxMemoryBytes, maxNanoCpus, network: { name: network['name'], id: network['id'] } });
};

/** The app and exact commit come from the trusted deployment request, not the bundle. */
type Scope = { readonly app: string; readonly commit: string };

/** Compile only a proposed candidate; this is not admission or a release plan. */
export const compileHttpCandidate = async (scope: Scope, input: unknown, authority: HttpCandidateAuthority) => {
  // Snapshot before the first await, including all nested caller-owned arrays.
  const expected = copy(scope);
  if (!object(expected) || !exact(expected, ['app', 'commit']) || !name(expected['app']) || typeof expected['commit'] !== 'string' || !/^[a-f0-9]{40}$/.test(expected['commit'])) return err('invalid trusted scope');
  const candidate = parseInput(copy(input));
  if (!candidate.ok) return candidate;
  if (candidate.value.app !== expected['app'] || candidate.value.commit !== expected['commit']) return err('candidate does not match deployment scope');
  const registration = parseRegistration(copy(await authority.registration(candidate.value.app)), candidate.value.app);
  if (!registration.ok) return registration;
  const { resources, route } = candidate.value;
  if (!registration.value.hosts.includes(route.host) || resources.memoryBytes > registration.value.maxMemoryBytes || resources.nanoCpus > registration.value.maxNanoCpus) return err('candidate exceeds registration grants');
  const { app, service, commit, image: ref } = candidate.value;
  const verified: unknown = await authority.verifyImage(Object.freeze({ app, service, commit, image: ref }));
  if (verified !== true) return err('image ownership or digest could not be verified');
  return ok(Object.freeze({ ...candidate.value, resources: Object.freeze({ ...resources }), health: Object.freeze({ ...candidate.value.health }), route: Object.freeze({ ...route }), network: Object.freeze({ ...registration.value.network }) }));
};
