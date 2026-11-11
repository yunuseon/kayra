import { strict as assert } from "node:assert";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { test, type TestContext } from "node:test";
import { dockerApi } from "../../src/server/runtime/docker-api.ts";

// eslint-disable-next-line functional/prefer-immutable-types -- test server and cleanup lifecycle
const fixture = async (t: TestContext, handle: (request: IncomingMessage, response: ServerResponse) => void) => {
  const directory = await mkdtemp(join(tmpdir(), "ka-api-"));
  const socket = join(directory, "api.sock");
  const server = createServer(handle);
  server.listen(socket);
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await rm(directory, { recursive: true, force: true });
  });
  return dockerApi(socket);
};

test("Docker adapter transport sends one structured request and accepts empty replies", async (t) => {
  // eslint-disable-next-line functional/prefer-immutable-types -- capture transport observations
  const calls: { readonly method: string | undefined; readonly path: string | undefined; readonly body: string }[] = [];
  const api = await fixture(t, (request, response) => {
    void text(request).then((body) => {
      // eslint-disable-next-line functional/immutable-data -- test observation
      calls.push({ method: request.method, path: request.url, body });
      response.writeHead(request.method === "DELETE" ? 204 : 201, { "Content-Type": "application/json" });
      response.end(request.method === "DELETE" ? undefined : JSON.stringify({ ID: "owned" }));
    });
  });
  assert.deepEqual(await api.request("POST", "/services/create", { Name: "fixture", Env: ["KEY=VALUE"] }), { status: 201, value: { ID: "owned" } });
  assert.deepEqual(await api.request("DELETE", "/services/owned"), { status: 204, value: null });
  assert.deepEqual(calls, [{ method: "POST", path: "/services/create", body: '{"Name":"fixture","Env":["KEY=VALUE"]}' }, { method: "DELETE", path: "/services/owned", body: "" }]);
});

test("Docker adapter transport never retries server errors or a dropped reply", async (t) => {
  // eslint-disable-next-line functional/no-let -- count transport effects
  let calls = 0;
  const api = await fixture(t, (request, response) => {
    calls += 1;
    if (request.url === "/drop") request.socket.destroy();
    else {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end('{"message":"unavailable"}');
    }
  });
  assert.deepEqual(await api.request("POST", "/error", {}), { status: 503, value: { message: "unavailable" } });
  assert.equal(calls, 1);
  await assert.rejects(api.request("POST", "/drop", {}), /interrupted or unavailable/);
  assert.equal(calls, 2);
});

test("Docker transport bounds bytes and time and does not disclose malformed response data", async (t) => {
  const api = await fixture(t, (request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    switch (request.url ?? "") {
      case "/invalid": response.end("PRIVATE-RESPONSE-CONTENTS"); break;
      case "/oversized": response.end('"' + "x".repeat(4 * 1024 * 1024 + 1) + '"'); break;
      default: break;
    }
  });
  await assert.rejects(api.request("GET", "/invalid"), { message: "Docker API returned invalid JSON" });
  await assert.rejects(api.request("GET", "/oversized"), /transport limit/);
  await assert.rejects(api.request("GET", "/hang", undefined, { timeoutMs: 20 }), /interrupted or unavailable/);
  await assert.rejects(api.request("POST", "/large", { value: "x".repeat(4 * 1024 * 1024) }), /transport limit/);
  await assert.rejects(api.request("GET", "/unsafe\r\nHeader:value"), /invalid Docker API path/);
  await assert.rejects(api.request("GET", "/", undefined, { timeoutMs: 0 }), /timeout/);
});
