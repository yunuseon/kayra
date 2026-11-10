import { strict as assert } from "node:assert";
import { execFile, execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { deployerControlHandler } from "../../../cli/src/deployer/deployer.ts";
import { registrationControl } from "../../../cli/src/server/deployment/registration-control.ts";
import { createLifecycleAppIndex, openLifecycleAppIndex } from "../../../cli/src/server/deployment/lifecycle-app-index.ts";

import { registrationObservation } from "../../../cli/src/server/platform/registration-observation.ts";

const app = "fixture-app-";
const fixture = JSON.parse(await readFile(new URL("../../../ci/tests/registration-generation/fixture.json", import.meta.url), "utf8"));
const platform = (mode, root, input) => JSON.parse(execFileSync("python3", [
  "-B", fileURLToPath(new URL("../../../scripts/server-lib/registration_command.py", import.meta.url)),
  mode, "--root", join(root, "platform"), "--private-gid", "0",
], { input: JSON.stringify(input), encoding: "utf8", timeout: 5000 }));
const stage = (root) => platform("stage", root, {
  app, registration: fixture.registration, configuration: fixture.configuration, secrets: fixture.secrets,
}).generation;
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
        } finally {
          await control.close();
          await index.close();
        }
        const reopened = await openLifecycleAppIndex(join(root, "index"));
        try {
          assert.equal(await reopened.reserveRegistration(app, generation), ticket);
          assert.deepEqual(await reopened.submitRegistration(app, ticket, generation), unpublished
            ? { status: "reconcile", actionId: ticket }
            : { status: "terminal", outcome: "success" });
        } finally {
          await reopened.close();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
