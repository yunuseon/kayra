import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { handleApi, stopRuns, type Api } from "./clients/api/api.ts";
import { admit, cookieName, tokenIn } from "./clients/api/auth.ts";
import { serveAsset } from "./clients/ui/assets.ts";
import { send } from "./deployer/http.ts";

export type Listening = { readonly url: string; readonly port: number; readonly close: () => Promise<void> };

/**
 * kayra's local server: the API and the browser side, on 127.0.0.1 only.
 * Every request needs this listener's Host, a write its Origin, the API
 * this launch's token (a cookie the opened URL sets).
 */
export const serve = (api: Api, assets: string | undefined, port: number): Promise<Listening> => {
  const token = randomBytes(32).toString("base64url");
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const at = listening();
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${String(at)}`);
      const method = request.method ?? "GET";
      const admission = admit({ method, path: url.pathname, host: request.headers.host, origin: request.headers.origin, cookie: request.headers.cookie }, at, token);
      if (!admission.admitted) {
        send(response, admission.status, `${admission.why}\n`);
        return;
      }
      if (url.pathname === "/login") {
        if (!tokenIn(url.searchParams, token)) {
          send(response, 401, "not this launch's token: open the URL kayra printed\n");
          return;
        }
        response.writeHead(303, { "Set-Cookie": `${cookieName(at)}=${token}; HttpOnly; SameSite=Strict; Path=/`, Location: "/" });
        response.end();
        return;
      }
      if (!url.pathname.startsWith("/api/")) {
        serveAsset(assets, url.pathname, response);
        return;
      }
      handleApi(api, request, response, url).catch((error: unknown) => {
        if (!response.headersSent) send(response, 500, `${error instanceof Error ? error.message : String(error)}\n`);
        else response.end();
      });
    });
    const listening = (): number => {
      const address = server.address();
      return typeof address === "object" && address !== null ? address.port : port;
    };
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const actual = listening();
      resolve({
        url: `http://127.0.0.1:${String(actual)}/login?token=${token}`,
        port: actual,
        close: () =>
          new Promise((done) => {
            stopRuns();
            server.closeAllConnections();
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
};
