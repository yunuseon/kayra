import { err, ok } from '../../lib/result.ts';

const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const unknownKey = (value: Readonly<Record<string, unknown>>, keys: readonly string[]) =>
  Object.keys(value).find((key) => !keys.includes(key));
const name = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 48 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const words = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.length > 0 && typeof value[0] === 'string' && value[0].length > 0 && value.every((word: unknown) => typeof word === 'string' && !word.includes('\0'));
const registryName = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const [host, port, ...extra] = value.split(':');
  if (host === undefined || host.length > 253 || extra.length > 0 || !host.split('.').every((part) => part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) return false;
  // Docker otherwise treats the first component as a Docker Hub namespace.
  if (host !== 'localhost' && !host.includes('.') && port === undefined) return false;
  return port === undefined || (/^[1-9][0-9]{0,4}$/.test(port) && Number(port) <= 65535);
};
const ownedImage = (value: unknown, registry: string, app: string): value is string => {
  if (typeof value !== 'string' || !value.startsWith(`${registry}/${app}/`)) return false;
  const [imageName, digest, ...extra] = value.split('@');
  if (imageName === undefined || imageName.length > 255 || digest === undefined || !/^sha256:[a-f0-9]{64}$/.test(digest) || extra.length > 0) return false;
  return imageName.slice(`${registry}/${app}/`.length).split('/').every((part) => /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(part));
};
const nanos = (seconds: number) => seconds * 1_000_000_000;

/**
 * Render only the workload part of a single rolling HTTP service. The caller
 * supplies the registry and overlay name/ID from platform configuration, not
 * the app. This is not deployable on its own: routing, validated rollout
 * policy, admission, ownership checks and reconciliation are still required.
 * The existing HTTP lab used a 5-second rollback monitor and no CPU limits;
 * this renderer's 30-second rollback monitor and CPU budgets need integration
 * testing against Docker and Traefik.
 */
export const renderSwarmHttp = (input: unknown) => {
  if (!record(input)) return err('service must be a mapping');
  const extra = unknownKey(input, ['app', 'service', 'registry', 'image', 'network', 'networkId', 'memoryBytes', 'reserveMemoryBytes', 'nanoCpus', 'reserveNanoCpus', 'health', 'stopGraceSeconds']);
  if (extra !== undefined) return err(`unsupported service field ${extra}`);
  const { app, service, registry, image, network, networkId, memoryBytes, reserveMemoryBytes, nanoCpus, reserveNanoCpus, health, stopGraceSeconds } = input;
  if (!name(app) || !name(service) || `kayra-${app}--${service}`.length > 63) return err('invalid app or service name');
  if (!registryName(registry)) return err('invalid registry');
  if (!ownedImage(image, registry, app)) return err('image must be an app-owned immutable digest');
  if (!name(network) || typeof networkId !== 'string' || !/^[a-z0-9]{25}$/.test(networkId)) return err('invalid platform overlay identity');
  if (!positive(memoryBytes) || !positive(reserveMemoryBytes) || reserveMemoryBytes > memoryBytes) return err('invalid memory budget');
  if (!positive(nanoCpus) || !positive(reserveNanoCpus) || reserveNanoCpus > nanoCpus) return err('invalid CPU budget');
  if (!positive(stopGraceSeconds) || stopGraceSeconds > 300) return err('invalid shutdown grace period');
  if (!record(health)) return err('health check is required');
  const healthExtra = unknownKey(health, ['command', 'intervalSeconds', 'timeoutSeconds', 'startPeriodSeconds', 'retries']);
  if (healthExtra !== undefined) return err(`unsupported health field ${healthExtra}`);
  const { command, intervalSeconds, timeoutSeconds, startPeriodSeconds, retries } = health;
  if (!words(command) || !positive(intervalSeconds) || intervalSeconds > 300 || !positive(timeoutSeconds) || timeoutSeconds > intervalSeconds || typeof startPeriodSeconds !== 'number' || !Number.isSafeInteger(startPeriodSeconds) || startPeriodSeconds < 0 || startPeriodSeconds > 300 || !positive(retries) || retries > 100) return err('invalid health check');

  return ok({
    Name: `kayra-${app}--${service}`,
    Labels: {
      'com.kayra.app': app,
      'com.kayra.service': service,
      'traefik.swarm.network': network,
      'traefik.swarm.lbswarm': 'true',
    },
    TaskTemplate: {
      ContainerSpec: {
        Image: image,
        Healthcheck: { Test: ['CMD', ...command], Interval: nanos(intervalSeconds), Timeout: nanos(timeoutSeconds), StartPeriod: nanos(startPeriodSeconds), Retries: retries },
        StopGracePeriod: nanos(stopGraceSeconds),
      },
      Resources: {
        Limits: { MemoryBytes: memoryBytes, NanoCPUs: nanoCpus },
        Reservations: { MemoryBytes: reserveMemoryBytes, NanoCPUs: reserveNanoCpus },
      },
      RestartPolicy: { Condition: 'any', Delay: nanos(1) },
      Networks: [{ Target: networkId }],
    },
    Mode: { Replicated: { Replicas: 1 } },
    UpdateConfig: { Parallelism: 1, Order: 'start-first', Monitor: nanos(30), FailureAction: 'rollback', MaxFailureRatio: 0 },
    RollbackConfig: { Parallelism: 1, Order: 'start-first', Monitor: nanos(30), FailureAction: 'pause', MaxFailureRatio: 0 },
    EndpointSpec: { Mode: 'vip' },
  } as const);
};
