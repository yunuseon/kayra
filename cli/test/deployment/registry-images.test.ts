/* eslint-disable functional/no-let, functional/prefer-immutable-types, functional/immutable-data -- owns registry responses and clock */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { registryImages } from "../../src/server/runtime/registry-images.ts";

const hash = (bytes: string | Uint8Array) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
const oci = "application/vnd.oci.image.";
const fixture = async (t: TestContext) => {
  const values = new Map<string, Buffer>(); const calls: string[] = [];
  let override: ((path: string) => { readonly code?: number; readonly body?: Buffer; readonly redirect?: string }) | undefined; let clock = 1000;
  const server = createServer((request, response) => {
    assert.equal(request.method, "GET"); const path = request.url ?? ""; calls.push(path); const custom = override?.(path);
    const body = custom?.body ?? values.get(path); response.writeHead(custom?.code ?? (body === undefined ? 404 : 200), { "content-type": "application/json", ...(custom?.redirect === undefined ? {} : { location: custom.redirect }) }); response.end(body ?? "not found: private-registry-value");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise<void>((resolve) => server.close(() => { resolve(); })));
  const address = server.address(); assert.ok(address && typeof address !== "string"); const origin = `http://127.0.0.1:${String(address.port)}`;
  const store = (kind: "manifests" | "blobs", value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value)); const digest = hash(bytes); values.set(`/v2/shop/web/${kind}/${digest}`, bytes); return { digest, size: bytes.length };
  };
  const image = (config: unknown = { os: "linux", architecture: "arm64", config: {} }, docker = false) => {
    const description = store("blobs", config);
    const leaf = store("manifests", { schemaVersion: 2, mediaType: docker ? "application/vnd.docker.distribution.manifest.v2+json" : oci + "manifest.v1+json", config: { ...description, mediaType: docker ? "application/vnd.docker.container.image.v1+json" : oci + "config.v1+json" }, layers: [] });
    return { ref: "localhost:5000/shop/web@" + leaf.digest, leaf, description };
  };
  return { origin, values, calls, store, image, port: registryImages(origin, "arm64", () => clock), now: (value: number) => { clock = value; }, override: (value: NonNullable<typeof override>) => { override = value; } };
};

test("immutable OCI and Docker metadata is accepted without pulling images, writing or returning config values", async (t) => {
  const lab = await fixture(t);
  for (const docker of [false, true]) {
    const image = lab.image({ os: "linux", architecture: "arm64", config: { Env: ["TOKEN=private-image-value"], Volumes: null } }, docker);
    assert.equal(await lab.port.verify("shop", [image.ref, image.ref]), "accepted");
  }
  assert.equal(lab.calls.length, 4); assert.ok(lab.calls.every((path) => path.startsWith("/v2/shop/web/")));
});

test("inherited volumes and incompatible or malformed configuration are refused", async (t) => {
  const lab = await fixture(t);
  for (const config of [{ os: "linux", architecture: "arm64", config: { Volumes: { "/data": {} } } },
    { os: "linux", architecture: "arm64", config: { Volumes: [] } }, { os: "windows", architecture: "arm64" }, { os: "linux", architecture: "amd64" },
    { os: "linux", architecture: "arm64", "os.features": ["required-feature"] }]) assert.equal(await lab.port.verify("shop", [lab.image(config).ref]), "unsupported");
});

test("one unambiguous native platform is selected from a digest-verified image index", async (t) => {
  const lab = await fixture(t); const image = lab.image();
  const selected = { ...image.leaf, mediaType: oci + "manifest.v1+json", platform: { os: "linux", architecture: "arm64", variant: "v8" }, urls: ["http://untrusted.example/never-follow"] };
  const index = lab.store("manifests", { schemaVersion: 2, mediaType: oci + "index.v1+json", manifests: [{ ...selected, platform: { os: "unknown", architecture: "unknown" } }, selected] });
  assert.equal(await lab.port.verify("shop", ["localhost:5000/shop/web@" + index.digest]), "accepted"); assert.equal(lab.calls.length, 3);
  for (const entries of [[selected, selected], [{ ...selected, platform: { os: "linux", architecture: "amd64" } }], [{ ...selected, platform: { ...selected.platform, variant: "v9" } }], [{ ...selected, mediaType: oci + "index.v1+json" }]]) {
    const index = lab.store("manifests", { schemaVersion: 2, manifests: entries }); const before: number = lab.calls.length;
    assert.equal(await lab.port.verify("shop", ["localhost:5000/shop/web@" + index.digest]), "unsupported"); assert.equal(lab.calls.length, before + 1);
  }
});

test("foreign image identities and caller-controlled URLs cannot contact the registry", async (t) => {
  const lab = await fixture(t); const valid = lab.image().ref;
  for (const input of [valid.replace("shop/", "other/"), valid.replace("localhost:5000", "other.example"), valid.replace("/shop/web@", "/shop/../web@"), valid.replace(/@.*/, ":latest")]) assert.equal(await lab.port.verify("shop", [input]), "unsupported");
  assert.equal(await lab.port.verify("../shop", [valid]), "unsupported"); assert.equal(await lab.port.verify("shop", []), "unsupported"); assert.equal(lab.calls.length, 0);
  assert.throws(() => registryImages("http://user:password@127.0.0.1"), /trusted registry/); assert.throws(() => registryImages(lab.origin + "/foreign/path"), /trusted registry/);
});

test("corrupt manifests, config hashes, descriptor sizes and unavailable metadata never establish admission", async (t) => {
  const lab = await fixture(t); const image = lab.image(); const blob = `/v2/shop/web/blobs/${image.description.digest}`;
  for (const path of [`/v2/shop/web/manifests/${image.leaf.digest}`, blob]) {
    lab.override((current) => current === path ? { body: Buffer.from('{"secret":"private-registry-value"}') } : {});
    assert.equal(await lab.port.verify("shop", [image.ref]), "unavailable");
  }
  const wrong = lab.store("manifests", { schemaVersion: 2, config: { ...image.description, size: image.description.size + 1, mediaType: oci + "config.v1+json" }, layers: [] });
  lab.override(() => ({})); assert.equal(await lab.port.verify("shop", ["localhost:5000/shop/web@" + wrong.digest]), "unavailable");
  for (const code of [404, 500, 302]) { lab.override(() => ({ code, redirect: "http://untrusted.example/never-follow" })); const before: number = lab.calls.length; assert.equal(await lab.port.verify("shop", [image.ref]), "unavailable"); assert.equal(lab.calls.length, before + 1); }
});

test("oversized bodies and the original whole-check deadline stop further metadata reads", async (t) => {
  const lab = await fixture(t); const image = lab.image(); lab.override(() => ({ body: Buffer.alloc(1024 * 1024 + 1, 32) })); assert.equal(await lab.port.verify("shop", [image.ref]), "unavailable");
  lab.override(() => { lab.now(11000); return {}; }); const before: number = lab.calls.length; assert.equal(await lab.port.verify("shop", [image.ref]), "unavailable"); assert.equal(lab.calls.length, before + 1);
});

test("case aliases, duplicate keys and invalid UTF-8 cannot conceal inherited volumes", async (t) => {
  const lab = await fixture(t);
  const raw = [
    '{"os":"linux","architecture":"arm64","config":{"Volumes":{"/data":{}}},"config":{}}',
    '{"os":"linux","architecture":"arm64","Config":{"Volumes":{"/data":{}}}}',
    '{"os":"linux","architecture":"arm64","config":{"volumes":{"/data":{}}}}',
    '{"os":"linux","architecture":"arm64","config":{"Volumeſ":{"/data":{}}}}',
    '{"os":"linux","architecture":"arm64","config":{},"\\u0063onfig":{"Volumes":{"/data":{}}}}',
  ].map((value) => Buffer.from(value));
  raw.push(Buffer.from([0xff]));
  for (const bytes of raw) {
    const digest = hash(bytes); lab.values.set(`/v2/shop/web/blobs/${digest}`, bytes);
    const leaf = lab.store("manifests", { schemaVersion: 2, config: { digest, size: bytes.length, mediaType: oci + "config.v1+json" }, layers: [] });
    assert.equal(await lab.port.verify("shop", ["localhost:5000/shop/web@" + leaf.digest]), "unavailable");
  }
  const valid = lab.image({ os: "linux", architecture: "arm64", config: { Env: ['TEXT={"config":{"Volumes":{}}}'], Labels: { example: "literal config and Volumes" } } });
  assert.equal(await lab.port.verify("shop", [valid.ref]), "accepted");
});

test("metadata nesting is bounded and the supported AMD64 platform remains accepted", async (t) => {
  const lab = await fixture(t); const bytes = Buffer.from('['.repeat(65) + '0' + ']'.repeat(65)); const digest = hash(bytes);
  lab.values.set(`/v2/shop/web/manifests/${digest}`, bytes); assert.equal(await lab.port.verify("shop", ["localhost:5000/shop/web@" + digest]), "unavailable");
  const image = lab.image({ os: "linux", architecture: "amd64", config: {} }); assert.equal(await registryImages(lab.origin, "amd64").verify("shop", [image.ref]), "accepted");
  const before = lab.calls.length; assert.equal(await registryImages(lab.origin, "riscv64").verify("shop", [image.ref]), "unsupported"); assert.equal(lab.calls.length, before);
});
