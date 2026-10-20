/** What a name must look like, and how a refusal says what it is not. */
export type Name = { readonly pattern: RegExp; readonly what: string };

/**
 * The rules names follow on both sides: the fleet's schemas (core/fleet/brand.ts)
 * and the deployer's constructors (deployer/brand.ts), which may not import zod.
 */
export const names = {
  app: { pattern: /^[a-z][a-z0-9-]*$/, what: "an app name (lowercase letters, digits, dashes)" },
  subdomain: { pattern: /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, what: "a subdomain" },
  /** A route's path prefix: no backtick, quote or `$`, so it cannot leave its Traefik rule or meet Compose's interpolation. */
  routePath: { pattern: /^\/[A-Za-z0-9._~%/-]*$/, what: "a path (/, then letters, digits and ._~%/-)" },
  serviceName: { pattern: /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, what: "a compose service name" },
  /** A Traefik duration. */
  period: { pattern: /^[1-9][0-9]*(ms|s|m|h)$/, what: "a period such as 10s, 10m or 1h" },
} as const satisfies Readonly<Record<string, Name>>;
