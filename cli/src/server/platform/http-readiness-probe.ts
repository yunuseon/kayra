import { request } from "node:https";

export type ReadinessOptions = {
  readonly address?: string; readonly port?: number; readonly ca?: string;
  readonly timeoutMs?: number; readonly now?: () => number;
};

/** One request per observation, fixed platform destination, trusted TLS, no redirects/retries/body buffering. */
export const httpReadinessProbe = ({ address = "traefik", port = 443, ca, timeoutMs = 2000, now = Date.now }: ReadinessOptions = {}) => {
  if (!/^[a-zA-Z0-9.-]+$/.test(address) || !Number.isSafeInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2000 ||
    (ca !== undefined && (ca.length > 256 * 1024 || !ca.includes("-----BEGIN CERTIFICATE-----") || ca.includes("PRIVATE KEY")))) throw new Error("invalid platform readiness policy");
  return (route: { readonly host: string; readonly check: string }) => {
    const result = (status: "ready" | "unready" | "unavailable") => Object.freeze({ status, checkedAt: now() });
    return new Promise<ReturnType<typeof result>>((resolve) => {
      const probe = request({ hostname: address, port, servername: route.host, path: route.check, method: "GET", headers: { Host: route.host, Connection: "close" },
        agent: false, rejectUnauthorized: true, ...(ca === undefined ? {} : { ca }), signal: AbortSignal.timeout(timeoutMs),
      }, (response) => {
        const code = response.statusCode ?? 0; resolve(result(code >= 200 && code < 400 ? "ready" : "unready")); response.destroy();
      });
      probe.once("error", () => { resolve(result("unavailable")); }); probe.end();
    });
  };
};
