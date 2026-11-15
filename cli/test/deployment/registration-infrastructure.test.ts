import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseRegistrationInfrastructure } from "../../src/contracts/registration-infrastructure.ts";
import { parseSwarmAuthority } from "../../src/contracts/swarm-authority.ts";
import { readRegistrationInfrastructure } from "../../src/server/platform/registration-infrastructure.ts";

const fixture = async () => {
  const raw: unknown = JSON.parse(await readFile(new URL("../../../ci/tests/registration-generation/infrastructure.json", import.meta.url), "utf8"));
  const reference = parseRegistrationInfrastructure(raw); assert.ok(reference.ok); return reference.value;
};
test("the shared infrastructure fixture binds the exact owner, incarnation and physical overlay grant", async () => {
  const reference = await fixture(); assert.ok(Object.isFrozen(reference)); assert.ok(Object.isFrozen(reference.overlay));
  for (const input of [
    { ...reference, authority: true }, { ...reference, runtime: "compose" },
    { ...reference, overlay: { ...reference.overlay, scope: { ...reference.overlay.scope, app: "foreign" } } },
    { ...reference, overlay: { ...reference.overlay, scope: { ...reference.overlay.scope, incarnation: "44444444-4444-4444-8444-444444444444" } } },
    { ...reference, overlay: { ...reference.overlay, scope: { ...reference.overlay.scope, name: "platform-swarm" } } },
    { ...reference, overlay: { ...reference.overlay, scope: { ...reference.overlay.scope, cluster: "invalid" } } },
    { ...reference, overlay: { ...reference.overlay, id: "invalid" } },
  ]) assert.equal(parseRegistrationInfrastructure(input).ok, false);
});

test("platform infrastructure reader requires a matching immutable owner and host without generating missing grants", { skip: process.platform !== "linux" || process.getuid?.() !== 0 }, async () => {
  const root = await mkdtemp("/var/lib/kayra-infrastructure-publication-");
  try {
    const reference = await fixture(); const owner = reference;
    const raw: unknown = JSON.parse(await readFile(new URL("../../../ci/tests/swarm-host/authority.json", import.meta.url), "utf8")); const host = parseSwarmAuthority(raw); assert.ok(host.ok);
    const source = `
import json, os, sys
from pathlib import Path
import registration_generation as storage
fixture = json.loads(Path(sys.argv[2]).read_text())
reference = json.load(sys.stdin)
owner = {key: reference[key] for key in ("version", "runtime", "registration", "ownership")}
registration = {**fixture["registration"], "name": owner["registration"]["app"], "runtime": "swarm", "grants": {"memory_bytes": 268435456, "cpu_millicores": 500, "maintenance": False}}
root = os.open(sys.argv[1], storage._DIR_FLAGS)
try:
    storage.publish(root, owner["registration"], registration, fixture["configuration"], fixture["secrets"], 0, ownership=owner, infrastructure=reference)
finally:
    os.close(root)
`;
    execFileSync("python3", ["-B", "-c", source, root, fileURLToPath(new URL("../../../ci/tests/registration-generation/fixture.json", import.meta.url))], { input: JSON.stringify(reference), env: { ...process.env, PYTHONPATH: fileURLToPath(new URL("../../../scripts/server-lib/", import.meta.url)) }, timeout: 10000 });
    const directory = join(root, "public"); const read = () => readRegistrationInfrastructure(directory, owner.registration, host.value);
    assert.deepEqual(await read(), { ok: true, value: reference });
    assert.equal((await readRegistrationInfrastructure(directory, owner.registration, { ...host.value, cluster: "z".repeat(25) })).ok, false);
    assert.equal((await readRegistrationInfrastructure(directory, owner.registration, { ...host.value, network: { ...host.value.network, id: reference.overlay.id } })).ok, false);
    const path = join(directory, createHash("sha256").update(owner.registration.app).digest("hex"), "generations", owner.registration.registrationGeneration, "infrastructure.json");
    await chmod(path, 0o644); assert.equal((await read()).ok, false);
    await writeFile(path, JSON.stringify({ ...reference, ownership: { ...reference.ownership, dataOwner: "44444444-4444-4444-8444-444444444444" } })); await chmod(path, 0o444); assert.equal((await read()).ok, false);
    await unlink(path); assert.equal((await read()).ok, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
