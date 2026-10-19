import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { within } from "./core/fleet/brand.ts";
import { createApi, type Api } from "./clients/api/api.ts";
import { admit, cookieName, tokenIn } from "./clients/api/auth.ts";
import { discover } from "./clients/api/discovery.ts";
import { serveAsset } from "./clients/ui/assets.ts";
import { send } from "./deployer/http/http.ts";

export type Listening = { readonly url: string; readonly port: number; readonly discovery?: string; readonly close: () => Promise<void> };
export type Clients = { readonly ui: boolean; readonly api: boolean };

export const serve = (config: Api, assets: string | undefined, port: number, clients: Clients = { ui: true, api: false }) => {
  const token = randomBytes(32).toString("base64url");
  const api = createApi(config);
  return new Promise<Listening>((resolve, reject) => {
    const server = createServer((request, response) => {
      const at = listening();
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${String(at)}`);
      const admission = admit({ method: request.method ?? "GET", path: url.pathname, host: request.headers.host, origin: request.headers.origin, cookie: request.headers.cookie, authorization: request.headers.authorization }, at, token, clients);
      if (!admission.admitted) { send(response, admission.status, `${admission.why}\n`); return; }
      if (url.pathname === "/login" && clients.ui) {
        if (!tokenIn(url.searchParams, token)) { send(response, 401, "not this launch's token: open the URL kayra printed\n"); return; }
        response.writeHead(303, { "Set-Cookie": `${cookieName(at)}=${token}; HttpOnly; SameSite=Strict; Path=/`, Location: "/", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
        response.end(); return;
      }
      if (url.pathname.startsWith("/api/")) {
        api.handle(request, response, url).catch(() => {
          if (!response.headersSent) send(response, 500, "kayra could not complete this request\n"); else response.end();
        });
      } else if (clients.ui) serveAsset(assets, url.pathname, response);
      else send(response, 404, "the browser interface is not enabled\n");
    });
    const listening = () => {
      const address = server.address();
      return typeof address === "object" && address !== null ? address.port : port;
    };
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const actual = listening();
      const base = `http://127.0.0.1:${String(actual)}`;
      const file = within(config.fleet.root, ".cache", "serve.json");
      try {
        const discovery = clients.api ? discover(file, `${base}/api`, token) : undefined;
        if (discovery !== undefined && !discovery.ok) {
          server.close(); reject(new Error(discovery.error)); return;
        }
        resolve({
          url: clients.ui ? `${base}/login?token=${token}` : `${base}/api`, port: actual,
          ...(clients.api ? { discovery: file } : {}),
          close: async () => {
            const stopping = api.stop();
            server.closeAllConnections();
            await Promise.all([stopping, new Promise<void>((done) => { server.close(() => { done(); }); })]);
            if (discovery?.ok === true) discovery.value.remove();
          },
        });
      } catch (error) { server.close(); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  });
};
