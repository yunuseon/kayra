import type { App } from "./app-registration.ts";
import type { ServiceHealth, ServiceResources } from "./compose-description.ts";
import type { RegistrationGeneration } from "./registration-generation.ts";
import type { Rollout, Runtime } from "./rollout.ts";
import type { SwarmAuthority, SwarmGrants } from "./swarm-authority.ts";

export type EnvironmentBinding =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "configuration" | "secret"; readonly key: string };
export type ArtifactRoute = {
  readonly host: string;
  readonly service: string;
  readonly port: number;
  readonly path: string | undefined;
  readonly check: string | undefined;
  readonly rateLimit: { readonly average: number; readonly period: string; readonly burst: number } | undefined;
};
export type HttpArtifact = {
  readonly artifact: string;
  readonly sha: string;
  readonly registration: RegistrationGeneration | undefined;
  readonly rollout: Rollout | undefined;
  readonly images: readonly { readonly variable: string; readonly ref: string }[];
  readonly routes: readonly ArtifactRoute[];
};
export type HttpPlanScope = {
  readonly registration: RegistrationGeneration;
  readonly runtime: Runtime;
  readonly app: App;
  readonly authority: SwarmAuthority;
  readonly domain: string;
  readonly configuration: { readonly identity: string; readonly keys: readonly string[] };
};
export type ApplicationPlan = {
  readonly version: 1;
  readonly runtime: "swarm";
  readonly app: string;
  readonly registration: RegistrationGeneration;
  readonly commit: string;
  readonly artifact: string;
  readonly host: SwarmAuthority;
  readonly grants: SwarmGrants;
  readonly configurationIdentity: string;
  readonly rollout: Rollout;
  readonly policy: { readonly version: 1; readonly failureMonitorSeconds: 30; readonly updateTimeoutSeconds: 90; readonly rollbackTimeoutSeconds: 90 };
  readonly services: Readonly<Record<string, {
    readonly image: string;
    readonly environment: Readonly<Record<string, EnvironmentBinding>>;
    readonly command: readonly string[] | null;
    readonly entrypoint: readonly string[] | null;
    readonly resources: ServiceResources;
    readonly health: ServiceHealth;
    readonly stopGraceSeconds: number;
  }>>;
  readonly routes: readonly {
    readonly host: string;
    readonly path: string | null;
    readonly service: string;
    readonly port: number;
    readonly check: string;
    readonly rateLimit: { readonly average: number; readonly period: string; readonly burst: number } | null;
  }[];
};
export type HttpPlanPort = {
  readonly preview: (registration: RegistrationGeneration, runtime: Runtime, commit: string, artifact: string) => Promise<ApplicationPlan>;
};
