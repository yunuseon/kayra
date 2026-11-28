export type ServiceResources = {
  readonly memoryBytes: number;
  readonly reserveMemoryBytes: number;
  readonly nanoCpus: number;
  readonly reserveNanoCpus: number;
};
export type ServiceHealth = {
  readonly command: readonly string[];
  readonly intervalSeconds: number;
  readonly timeoutSeconds: number;
  readonly startPeriodSeconds: number;
  readonly retries: number;
};
export type DescribedService = {
  readonly image: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly command: readonly string[] | null;
  readonly entrypoint: readonly string[] | null;
  readonly resources: ServiceResources;
  readonly health: ServiceHealth;
  readonly stopGraceSeconds: number;
};
export type ComposeDescription = { readonly services: Readonly<Record<string, DescribedService>> };
export type DescriptionFile = { readonly path: string; readonly content: string };
