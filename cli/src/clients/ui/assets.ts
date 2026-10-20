import { existsSync, readFileSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";

const types: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json; charset=utf-8",
};

const unbuilt = `<!doctype html><meta charset="utf-8"><title>kayra</title>
<body style="font:15px system-ui;margin:3rem auto;max-width:40rem"><h1>kayra</h1>
<p>The browser side is not built in this checkout:</p><pre>npm --prefix web ci &amp;&amp; npm --prefix web run build</pre>
<p>The API is up at <code>/api/fleet</code>.</p></body>`;

/**
 * The built browser side (web/dist in a checkout, cli/dist/browser in the
 * package); a path that is no file is the app's own route, answered by its
 * index; without a build, a page saying how to make one.
 */
export const serveAsset = (assets: string | undefined, path: string, response: ServerResponse) => {
  if (assets === undefined) {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(unbuilt);
    return;
  }
  const file = normalize(join(assets, decodeURIComponent(path)));
  const inside = file.startsWith(assets + sep) && existsSync(file) && statSync(file).isFile();
  const chosen = inside ? file : join(assets, "index.html");
  response.writeHead(200, {
    "Content-Type": types[extname(chosen)] ?? "application/octet-stream",
    "Cache-Control": chosen.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
  });
  response.end(readFileSync(chosen));
};
