import { strict as assert } from "node:assert";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createLifecycleAppIndex, openLifecycleAppIndex } from "../../../cli/src/server/deployment/lifecycle-app-index.ts";

const app = "fixture-app-";
const generation = "22222222-2222-4222-8222-222222222222";
const platform = (mode, root, expected) => execFileSync("python3", [
  "-B", fileURLToPath(new URL("platform_fixture.py", import.meta.url)), mode, join(root, "platform"),
], { input: JSON.stringify(expected), encoding: "utf8", timeout: 5000 });
const observe = (root, expected) => JSON.parse(platform("observe", root, expected));
const signalParent = (message) => new Promise((resolve, reject) => {
  process.send(message, (error) => error ? reject(error) : resolve());
});

async function runWriter(root, checkpoint) {
  const index = await createLifecycleAppIndex(join(root, "index"), async (expected) => {
    const evidence = observe(root, expected);
    assert.equal(evidence.status, "applied");
    await signalParent({ ticket: expected.actionId, checkpoint });
    return new Promise(() => {});
  });
  const incarnation = await index.prepareApp(app);
  const ticket = await index.reserveRegistration(app, generation);
  if (checkpoint === "lost-allocation-reply") {
    await signalParent({ checkpoint });
    return;
  }
  const intent = await index.submitRegistration(app, ticket, generation);
  assert.deepEqual(intent, { status: "new", actionId: ticket });
  if (checkpoint !== "before-publish") {
    platform("publish", root, { app, incarnation, actionId: intent.actionId, registrationGeneration: generation });
  }
  if (checkpoint === "after-observe") {
    await index.reconcileRegistration(app, ticket, generation);
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
      const root = await mkdtemp(join(tmpdir(), "kayra-indexed-flow-"));
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
        const unpublished = checkpoint === "before-publish" || checkpoint === "lost-allocation-reply";
        const observations = [];
        const index = await openLifecycleAppIndex(join(root, "index"), async (expected) => {
          const evidence = observe(root, expected);
          observations.push(evidence.status);
          return evidence;
        });
        try {
          const recovered = await index.reserveRegistration(app, generation);
          if (checkpoint === "lost-allocation-reply") {
            assert.match(recovered, /:1$/);
            ticket = recovered;
          } else {
            assert.equal(recovered, ticket);
          }
          await assert.rejects(index.reserveRegistration(app, "33333333-3333-4333-8333-333333333333"), /allocation conflict/);
          assert.deepEqual(await index.submitRegistration(app, ticket, generation), {
            status: checkpoint === "lost-allocation-reply" ? "new" : "reconcile", actionId: ticket,
          });
          assert.deepEqual(await index.reconcileRegistration(app, ticket, generation), {
            status: unpublished ? "pending" : "verified",
          });
          assert.deepEqual(observations, [unpublished ? "unknown" : "applied"]);
        } finally {
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
