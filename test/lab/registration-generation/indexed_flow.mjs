import { strict as assert } from "node:assert";
import { execFile, execFileSync, fork, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { builderInternalHandler } from "../../../cli/src/server/builder/builder.ts";
import { builderResolve } from "../../../cli/src/deployer/build/client.ts";
import { createHash } from "node:crypto";
import { deployerControlHandler } from "../../../cli/src/deployer/deployer.ts";
import { registrationControl } from "../../../cli/src/server/deployment/registration-control.ts";
import { createLifecycleAppIndex, openLifecycleAppIndex } from "../../../cli/src/server/deployment/lifecycle-app-index.ts";

import { readPrivateRegistration } from "../../../cli/src/server/platform/private-registration.ts";
import { readPublicRegistration } from "../../../cli/src/server/platform/public-registration.ts";
import { registrationObservation } from "../../../cli/src/server/platform/registration-observation.ts";

const app = "fixture-app-";
const fixture = JSON.parse(await readFile(new URL("../../../ci/tests/registration-generation/fixture.json", import.meta.url), "utf8"));
const platform = (mode, root, input) => JSON.parse(execFileSync("python3", [
  "-B", fileURLToPath(new URL("../../../scripts/server-lib/registration_command.py", import.meta.url)),
  mode, "--root", join(root, "platform"), "--private-gid", "0",
], { input: JSON.stringify(input), encoding: "utf8", timeout: 5000 }));
const request = { app, registration: fixture.registration, configuration: fixture.configuration, secrets: fixture.secrets };
const stage = (root) => platform("stage", root, request).generation;
const hostFlow = async (root) => {
  const source = `
import json, subprocess, sys
from registration_command import register, trusted_root

def ctl(*args):
    result = subprocess.run([sys.argv[2], sys.argv[3], "ctl", "registration", *args],
                            check=True, capture_output=True, timeout=15)
    return json.loads(result.stdout)

with trusted_root(sys.argv[1]) as root:
    print(json.dumps(register(root, 0, json.load(sys.stdin), ctl)))
`;
  const executable = execFile("python3", [
    "-B", "-c", source, join(root, "platform"), process.execPath,
    fileURLToPath(new URL("../../../cli/src/deployer/main.ts", import.meta.url)),
  ], {
    env: { ...process.env, PYTHONPATH: fileURLToPath(new URL("../../../scripts/server-lib/", import.meta.url)) },
    timeout: 12000,
  });
  const output = Array.fromAsync(executable.stdout);
  const exited = once(executable, "exit");
  executable.stdin.end(JSON.stringify(request));
  assert.deepEqual(await exited, [0, null]);
  return JSON.parse((await output).join(""));
};
const observe = (root) => registrationObservation(join(root, "platform", "observations"));

async function localControl(root, index) {
  const handler = deployerControlHandler({ PLATFORM_DIR: join(root, "legacy") }, registrationControl(index, async (name) => name === app));
  const server = createServer(handler).listen(8091, "127.0.0.1");
  await once(server, "listening");
  const main = fileURLToPath(new URL("../../../cli/src/deployer/main.ts", import.meta.url));
  const call = async (operation, { app, generation, ticket }) => {
    const args = [main, "ctl", "registration", operation, app, generation, ...(ticket === undefined ? [] : [ticket])];
    const { stdout } = await promisify(execFile)(process.execPath, args, { timeout: 17000 });
    return JSON.parse(stdout);
  };
  return { call, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

const signalParent = (message) => new Promise((resolve, reject) => {
  process.send(message, (error) => error ? reject(error) : resolve());
});

async function runWriter(root, checkpoint) {
  const generation = stage(root);
  const index = await createLifecycleAppIndex(join(root, "index"), async (expected, signal) => {
    const evidence = await observe(root)(expected, signal);
    assert.equal(evidence.status, "applied");
    await signalParent({ ticket: expected.actionId, checkpoint });
    return new Promise(() => {});
  });
  const control = await localControl(root, index);
  const { incarnation, ticket } = await control.call("reserve", { app, generation });
  if (checkpoint === "lost-allocation-reply") {
    await signalParent({ checkpoint });
    return;
  }
  const intent = await control.call("submit", { app, ticket, generation });
  assert.deepEqual(intent, { status: "new", actionId: ticket });
  if (checkpoint !== "before-publish") {
    const evidence = platform("publish", root, { version: 1, app, incarnation, actionId: intent.actionId, registrationGeneration: generation });
    assert.equal(evidence.status, "applied");
  }
  if (checkpoint === "after-observe") {
    await control.call("reconcile", { app, ticket, generation });
  } else {
    await signalParent({ ticket, checkpoint });
  }
}

if (process.argv[2] === "writer") {
  setInterval(() => {}, 1000);
  await runWriter(process.argv[3], process.argv[4]);
} else {
  for (const checkpoint of ["lost-allocation-reply", "before-publish", "after-publish", "after-observe"]) {
    test(checkpoint, { timeout: 15000 }, async () => {
      assert.equal(process.platform, "linux");
      assert.equal(process.getuid(), 0);
      const root = await mkdtemp("/var/lib/kayra-indexed-flow-");
      try {
        await mkdir(join(root, "platform"), { mode: 0o700 });
        const child = fork(fileURLToPath(import.meta.url), ["writer", root, checkpoint], { execArgv: [] });
        const exited = once(child, "exit");
        let ticket;
        try {
          const [message] = await Promise.race([
            once(child, "message", { signal: AbortSignal.timeout(10000) }),
            exited.then(() => { throw new Error("writer exited before checkpoint"); }),
          ]);
          assert.equal(message.checkpoint, checkpoint);
          ticket = message.ticket;
          await assert.rejects(openLifecycleAppIndex(join(root, "index")), /locked/);
        } finally {
          child.kill("SIGKILL");
          await exited;
        }

        assert.deepEqual(await exited, [null, "SIGKILL"]);
        const generation = stage(root);
        const unpublished = checkpoint === "before-publish" || checkpoint === "lost-allocation-reply";
        const index = await openLifecycleAppIndex(join(root, "index"), observe(root));
        const control = await localControl(root, index);
        try {
          const { ticket: recovered } = await control.call("reserve", { app, generation });
          if (checkpoint === "lost-allocation-reply") {
            assert.match(recovered, /:1$/);
            ticket = recovered;
          } else {
            assert.equal(recovered, ticket);
          }
          await assert.rejects(control.call("reserve", { app, generation: "33333333-3333-4333-8333-333333333333" }), /409/);
          await assert.rejects(control.call("reserve", { app: "out-of-scope", generation }), /409/);
          assert.deepEqual(await control.call("submit", { app, ticket, generation }), {
            status: checkpoint === "lost-allocation-reply" ? "new" : "reconcile", actionId: ticket,
          });
          assert.deepEqual(await control.call("reconcile", { app, ticket, generation }), {
            status: unpublished ? "pending" : "verified",
          });
          if (unpublished) assert.deepEqual(await hostFlow(root), { status: "verified" });
          assert.deepEqual(await hostFlow(root), { status: "terminal", outcome: "success" });
          const published = await readPublicRegistration(join(root, "platform", "public"), app);
          assert.ok(published.ok);
          assert.equal(published.value.metadata.registrationGeneration, generation);
          assert.deepEqual(published.value.app, fixture.registration);
          const privateInputs = await readPrivateRegistration(
            join(root, "platform", "private"), published.value.metadata, published.value.app.secrets, 0,
          );
          assert.deepEqual(privateInputs, { ok: true, value: { configuration: fixture.configuration, secrets: fixture.secrets } });
          const mismatched = await readPrivateRegistration(
            join(root, "platform", "private"), { ...published.value.metadata, actionId: published.value.metadata.incarnation + ":2" },
            published.value.app.secrets, 0,
          );
          assert.deepEqual(mismatched, { ok: false, error: "private registration identity mismatch" });
          const builder = createServer(builderInternalHandler({
            PLATFORM_DIR: join(root, "legacy"),
            KAYRA_PUBLIC_REGISTRATIONS_DIR: join(root, "platform", "public"),
          })).listen(0, "127.0.0.1");
          await once(builder, "listening");
          const builderUrl = `http://127.0.0.1:${builder.address().port}`;
          const publicPointer = join(root, "platform", "public", createHash("sha256").update(app).digest("hex"), "current.json");
          try {
            await rename(publicPointer, publicPointer + ".saved");
            const resolved = await builderResolve(builderUrl, published.value.app, "a".repeat(40), published.value.metadata);
            assert.deepEqual(resolved, { ok: true, value: "a".repeat(40) });
            const wrong = await builderResolve(builderUrl, published.value.app, "a".repeat(40), {
              ...published.value.metadata, actionId: published.value.metadata.incarnation + ":2",
            });
            assert.equal(wrong.ok, false);
            const unpinned = await builderResolve(builderUrl, published.value.app, "a".repeat(40));
            assert.equal(unpinned.ok, false);
          } finally {
            await rename(publicPointer + ".saved", publicPointer);
            await new Promise((resolve, reject) => builder.close((error) => error ? reject(error) : resolve()));
          }
        } finally {
          await control.close();
          await index.close();
        }
        const reopened = await openLifecycleAppIndex(join(root, "index"));
        try {
          assert.equal(await reopened.reserveRegistration(app, generation), ticket);
          assert.deepEqual(await reopened.submitRegistration(app, ticket, generation), { status: "terminal", outcome: "success" });
        } finally {
          await reopened.close();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}


if (process.argv[2] !== "writer") {
  test("the deployer opens the indexed control route only in the opted-in process", { timeout: 20000 }, async () => {
    const root = await mkdtemp("/var/lib/kayra-registration-daemon-");
    try {
      const platformDir = join(root, "legacy");
      await mkdir(join(root, "platform"), { mode: 0o700 });
      await mkdir(join(platformDir, "lifecycle"), { recursive: true });
      await mkdir(join(platformDir, "managed-apps"));
      const claimPath = join(platformDir, "managed-apps", app + ".json");
      const main = fileURLToPath(new URL("../../../cli/src/deployer/main.ts", import.meta.url));
      const call = async (...args) => {
        const { stdout } = await promisify(execFile)(process.execPath, [main, "ctl", "registration", ...args], { timeout: 5000 });
        return JSON.parse(stdout);
      };
      const run = async (enabled, exercise) => {
        const child = spawn(process.execPath, [main, "deployer"], {
          env: {
            ...process.env, PLATFORM_DIR: platformDir,
            KAYRA_REGISTRATION_EVIDENCE_DIR: enabled ? join(root, "platform", "observations") : undefined,
          },
          stdio: ["ignore", "pipe", "inherit"],
        });
        const exited = once(child, "exit");
        const lines = createInterface({ input: child.stdout });
        try {
          const [ready] = await Promise.race([
            once(lines, "line", { signal: AbortSignal.timeout(6000) }),
            exited.then(() => { throw new Error("deployer exited during startup"); }),
          ]);
          assert.match(ready, /^deployer:/);
          await exercise();
        } finally {
          child.kill("SIGKILL");
          await exited;
          lines.close();
        }
      };
      await run(false, async () => {
        await assert.rejects(call("initialize"), /404/);
      });
      await run(true, async () => {
        await assert.rejects(call("reserve", app, stage(root)), /409/);
        assert.deepEqual(await call("initialize"), { status: "ready" });
        await writeFile(claimPath, "", { mode: 0o444 });
        await assert.rejects(call("verified", app), /409/);
        assert.deepEqual(await hostFlow(root), { status: "verified" });
        const verified = await call("verified", app);
        assert.equal(verified.app, app);
        assert.equal(verified.registrationGeneration, stage(root));
        const saved = JSON.parse(await readFile(join(platformDir, "lifecycle", "app-index", createHash("sha256").update(app).digest("hex"), "state.json"), "utf8"));
        assert.deepEqual(saved.registrationReceipt, { ticket: saved.registrationAllocation.ticket, runtime: "compose", metadata: verified });
      });
      await run(true, async () => {
        assert.deepEqual(await hostFlow(root), { status: "terminal", outcome: "success" });
        const verified = await call("verified", app);
        assert.equal(verified.app, app);
        assert.equal(verified.registrationGeneration, stage(root));
        const saved = JSON.parse(await readFile(join(platformDir, "lifecycle", "app-index", createHash("sha256").update(app).digest("hex"), "state.json"), "utf8"));
        assert.deepEqual(saved.registrationReceipt, { ticket: saved.registrationAllocation.ticket, runtime: "compose", metadata: verified });
      });
      await rename(join(platformDir, "lifecycle", "app-index"), join(platformDir, "saved-app-index"));
      await run(true, async () => {
        await assert.rejects(call("initialize"), /409/);
        await assert.rejects(call("reserve", app, stage(root)), /409/);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
