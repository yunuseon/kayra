import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { BuildPorts } from "../../src/contracts/build-artifact.ts";
import { openArtifactStore } from "../../src/server/deployment/artifact-store.ts";
import { createLifecycleAppIndex, openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";

const generation = "22222222-2222-4222-8222-222222222222";
const commit = "a".repeat(40);
// eslint-disable-next-line functional/prefer-immutable-types -- test cleanup context
const fixture = async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "kayra-retained-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = await openArtifactStore(join(root, "artifacts"));
  const path = join(root, "index");
  const index = await createLifecycleAppIndex(path, (identity) => Promise.resolve({ ...identity, status: "applied" }));
  await index.prepareApp("shop");
  const ticket = await index.reserveRegistration("shop", generation);
  await index.submitRegistration("shop", ticket, generation);
  await index.reconcileRegistration("shop", ticket, generation);
  await index.prepareApp("unverified");
  const ports: BuildPorts = { images: () => ["localhost:5000/shop/web@sha256:" + "1".repeat(64)], now: () => 1000, ...artifacts, prepare: () => Promise.resolve('{"fixture":"content"}') };
  return { root, path, index, ports, artifacts };
};

test("concurrent build retries retain one verified artifact and survive restart without the builder", async (t) => {
  const { root, path, index, ports, artifacts } = await fixture(t);
  // eslint-disable-next-line functional/no-let -- count effects, not request invocations
  let calls = 0;
  const prepare: BuildPorts["prepare"] = async (identity, sha, deadline, signal, runtime) => {
    calls += 1;
    assert.equal(identity.registrationGeneration, generation);
    assert.equal(sha, commit);
    assert.equal(deadline, 1000 + 45 * 60_000);
    const journal = await readFile(join(path, "state.json"), "utf8");
    assert.ok(journal.includes('"artifact":null'));
    assert.ok(journal.includes(`"commit":"${commit}"`));
    return ports.prepare(identity, sha, deadline, signal, runtime);
  };
  const [first, duplicate] = await Promise.all([
    index.prepareBuild("shop", commit, { ...ports, prepare }),
    index.prepareBuild("shop", commit, { ...ports, prepare }),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(first, duplicate);
  assert.equal(await artifacts.read(first.artifact), '{"fixture":"content"}');
  await index.close();
  const reopened = await openLifecycleAppIndex(path);
  try {
    assert.deepEqual(await reopened.prepareBuild("shop", commit, { ...ports, now: () => first.deadline + 1, prepare: () => { throw new Error("builder unavailable"); } }), first);
    await rm(join(root, "artifacts", first.artifact + ".json"));
    await assert.rejects(reopened.prepareBuild("shop", commit, ports), { code: "ENOENT" });
    assert.equal(calls, 1);
  } finally { await reopened.close(); }
});

test("interrupted preparations retain the original deadline and cannot admit an unverified registration", async (t) => {
  const { path, index, ports } = await fixture(t);
  await assert.rejects(index.prepareBuild("unverified", commit, ports), /not been verified/);
  await assert.rejects(index.prepareBuild("shop", "main", ports), /full commit/);
  await assert.rejects(index.prepareBuild("shop", commit, { ...ports, prepare: () => { throw new Error("connection interrupted"); } }), /interrupted/);
  await index.close();
  const reopened = await openLifecycleAppIndex(path);
  try {
    const result = await reopened.prepareBuild("shop", commit, { ...ports, now: () => 2000 });
    assert.equal(result.deadline, 1000 + 45 * 60_000);
    const next = "b".repeat(40);
    await assert.rejects(reopened.prepareBuild("shop", next, { ...ports, now: () => 2000, prepare: () => { throw new Error("interrupted"); } }), /interrupted/);
    await assert.rejects(reopened.prepareBuild("shop", next, { ...ports, now: () => 2000 + 45 * 60_000 }), /deadline expired/);
  } finally { await reopened.close(); }
});

test("retention acknowledged before a lost receipt is replayed safely", async (t) => {
  const { path, index, ports, artifacts } = await fixture(t);
  const retain: BuildPorts["retain"] = async (content) => {
    await artifacts.retain(content);
    throw new Error("lost retention reply");
  };
  await assert.rejects(index.prepareBuild("shop", commit, { ...ports, retain }), /lost retention reply/);
  await index.close();
  const reopened = await openLifecycleAppIndex(path);
  try {
    const result = await reopened.prepareBuild("shop", commit, ports);
    assert.equal(await artifacts.read(result.artifact), '{"fixture":"content"}');
  } finally { await reopened.close(); }
});

test("artifact publication is immutable, bounded and rejects corruption or symlink substitution", async (t) => {
  const { root, index, artifacts } = await fixture(t);
  await index.close();
  const [digest, duplicate] = await Promise.all([artifacts.retain("hello"), artifacts.retain("hello")]);
  assert.equal(digest, duplicate);
  const path = join(root, "artifacts", digest + ".json");
  // A crash between link and unlink may leave an inert temporary hard link.
  await link(path, join(root, "artifacts", ".artifact-interrupted.tmp"));
  assert.equal(await artifacts.read(digest), "hello");
  await assert.rejects(artifacts.retain("a".repeat(4 * 1024 * 1024 + 1)), /limit/);
  await assert.rejects(artifacts.read("../escape"), /digest/);
  await chmod(path, 0o600);
  await writeFile(path, "wrong");
  await chmod(path, 0o400);
  await assert.rejects(artifacts.read(digest), /integrity/);
  await assert.rejects(artifacts.retain("hello"), /integrity/);
  await rm(path);
  const other = join(root, "other");
  await writeFile(other, "hello", { mode: 0o400 });
  await symlink(other, path);
  await assert.rejects(artifacts.read(digest));
  const target = join(root, "target");
  await mkdir(target, { mode: 0o700 });
  await symlink(target, join(root, "alias"));
  await assert.rejects(openArtifactStore(join(root, "alias")), /directory/);
  assert.equal(createHash("sha256").update("hello").digest("hex"), digest);
});

for (const boundary of ["intent", "retention"]) {
  test(`SIGKILL after ${boundary} resumes the recorded commit and deadline`, { timeout: 15_000 }, async (t) => {
    const { path, root, index, ports } = await fixture(t);
    await index.close();
    const source = `
      import { openLifecycleAppIndex } from ${JSON.stringify(new URL("../../src/server/deployment/lifecycle-app-index.ts", import.meta.url).href)};
      import { openArtifactStore } from ${JSON.stringify(new URL("../../src/server/deployment/artifact-store.ts", import.meta.url).href)};
      const index = await openLifecycleAppIndex(${JSON.stringify(path)});
      const artifacts = await openArtifactStore(${JSON.stringify(join(root, "artifacts"))});
      const stop = () => { console.log("boundary"); return new Promise(() => setInterval(() => {}, 1000)); };
      await index.prepareBuild("shop", ${JSON.stringify(commit)}, {
        now: () => 1000, read: artifacts.read, images: () => [],
        prepare: async () => ${boundary === "intent" ? 'stop()' : JSON.stringify('{"fixture":"content"}')},
        retain: async (content) => { const digest = await artifacts.retain(content); ${boundary === "retention" ? 'await stop();' : ''} return digest; },
      });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "inherit"] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    const lines = createInterface({ input: child.stdout });
    const line: unknown = (await once(lines, "line"))[0];
    assert.equal(line, "boundary");
    const exit = once(child, "exit");
    child.kill("SIGKILL");
    await exit;
    lines.close();
    const resumed = await openLifecycleAppIndex(path);
    try {
      const result = await resumed.prepareBuild("shop", commit, { ...ports, now: () => 2000 });
      assert.equal(result.commit, commit);
      assert.equal(result.deadline, 1000 + 45 * 60_000);
      assert.equal(await ports.read(result.artifact), '{"fixture":"content"}');
    } finally { await resumed.close(); }
  });
}

test("an unresponsive build port is cancelled at the persisted deadline", { timeout: 5000 }, async (t) => {
  const { index, ports } = await fixture(t);
  // eslint-disable-next-line functional/no-let -- advance a test clock to just before its persisted deadline
  let calls = 0;
  const cancelled = Promise.withResolvers<undefined>();
  try {
    await assert.rejects(index.prepareBuild("shop", commit, {
      ...ports,
      now: () => (++calls === 1 ? 1000 : 1000 + 45 * 60_000 - 10),
      prepare: (_identity, _commit, _deadline, signal) => {
        signal.addEventListener("abort", () => { cancelled.resolve(undefined); }, { once: true });
        return new Promise<string>(() => undefined);
      },
    }), /deadline expired/);
    await cancelled.promise;
  } finally { await index.close(); }
});

test("published build pins retain unresolved identities and refuse incomplete or foreign artifacts", async (t) => {
  const { root, path, index, ports } = await fixture(t);
  await assert.rejects(index.prepareBuild("shop", commit, { ...ports, prepare: () => { throw new Error("interrupted"); } }), /interrupted/);
  const pending = await index.imagePins(ports);
  assert.equal(pending.complete, false);
  assert.equal(pending.artifacts.length, 0);
  assert.equal(pending.unresolved.length, 1);
  assert.equal(pending.unresolved[0]?.commit, commit);
  assert.equal(pending.unresolved[0].deadline, 1000 + 45 * 60_000);
  const built = await index.prepareBuild("shop", commit, ports);
  await index.close();
  const reopened = await openLifecycleAppIndex(path);
  try {
    const pins = await reopened.imagePins(ports);
    assert.deepEqual(pins, {
      version: 1, complete: false, reason: "runtime plan pins are not integrated",
      artifacts: [{ build: built.id, registration: built.registration, commit, artifact: built.artifact,
        images: ["localhost:5000/shop/web@sha256:" + "1".repeat(64)] }],
      unresolved: [],
    });
    assert.equal(JSON.stringify(pins).includes("fixture"), false);
    assert.ok(Object.isFrozen(pins.artifacts));
    await assert.rejects(reopened.imagePins({ ...ports, images: () => ["localhost:5000/other/web@sha256:" + "1".repeat(64)] }), /ownership/);
    await rm(join(root, "artifacts", built.artifact + ".json"));
    await assert.rejects(reopened.imagePins(ports), { code: "ENOENT" });
  } finally { await reopened.close(); }
});

test("plan preview uses only the verified retained artifact and does not change build state", async (t) => {
  const { path, index, ports } = await fixture(t);
  try {
    await assert.rejects(index.previewPlan("shop", commit, { preview: () => { throw new Error("preview must not run without an artifact"); } }), /no retained build/);
    const retained = await index.prepareBuild("shop", commit, ports);
    const before = await readFile(join(path, "state.json"), "utf8");
    await assert.rejects(index.previewPlan("shop", commit, {
      preview: (registration, runtime, givenCommit, artifact) => {
        assert.deepEqual(registration, retained.registration);
        assert.equal(runtime, "compose");
        assert.equal(givenCommit, commit);
        assert.equal(artifact, retained.artifact);
        return Promise.reject(new Error("preview port observed its exact scope"));
      },
    }), /preview port observed/);
    assert.equal(await readFile(join(path, "state.json"), "utf8"), before);
  } finally { await index.close(); }
});
