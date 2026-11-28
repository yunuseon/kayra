import { createServer } from "node:http";
import { open, readFile, rename } from "node:fs/promises";

const query = async (target, path, options = {}) => {
  const response = await fetch(`http://${target}:8080${path}`, {
    ...options, signal: AbortSignal.timeout(750),
  });
  if (!response.ok) throw new Error(`fixture ${path} returned ${response.status}`);
  return response.json();
};

const serve = (handle) => {
  const server = createServer((req, res) => {
    handle(req).then((body) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    }, () => {
      res.statusCode = 503;
      res.end();
    });
  }).listen(8080, "0.0.0.0");
  process.on("SIGTERM", () => server.close());
};

const database = async () => {
  const path = "/data/ledger.json";
  let state = await readFile(path, "utf8").then(JSON.parse, (error) => {
    if (error.code !== "ENOENT") throw error;
    return { schema: 1, attempts: [] };
  });
  let effects = Promise.resolve();
  serve(async (req) => {
    if (req.method === "POST" && req.url === "/migrate") {
      const operation = req.headers["x-operation"];
      if (typeof operation !== "string" || !/^[0-9a-f-]{36}:schema$/.test(operation)) {
        throw new Error("missing stable migration identity");
      }
      const update = effects.then(async () => {
        const next = { schema: 2, attempts: [...state.attempts, operation] };
        const file = await open(path + ".next", "w");
        try {
          await file.writeFile(JSON.stringify(next));
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(path + ".next", path);
        const directory = await open("/data", "r");
        try { await directory.sync(); } finally { await directory.close(); }
        state = next;
      });
      effects = update.catch(() => {});
      await update;
    }
    return state;
  });
};

switch (process.argv[2]) {
  case "database":
    await database();
    break;
  case "web":
    serve(async () => {
      const { schema } = await query("db", "/state");
      if (String(schema) !== process.env.SCHEMA) throw new Error("schema incompatible");
      return { release: process.env.RELEASE, schema };
    });
    break;
  case "health":
    await query("127.0.0.1", "/health");
    break;
  case "migrate":
    await query("db", "/migrate", { method: "POST", headers: { "x-operation": process.env.KAYRA_OPERATION_ID } });
    break;
  case "check":
    if (process.env.CHECK_FAIL === "true") throw new Error("fixture release failed its completion check");
    await query("127.0.0.1", "/version");
    break;
  default:
    throw new Error("unknown fixture mode");
}
