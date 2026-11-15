import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseRegistrationOwnership } from "../../src/contracts/registration-ownership.ts";
import { readRegistrationOwnership } from "../../src/server/platform/registration-ownership.ts";

const linuxRoot = process.platform === "linux" && process.getuid?.() === 0;
test("platform reads exact published owner and refuses missing, changed-scope, unsafe and legacy ownership", { skip: !linuxRoot }, async () => {
  const root = await mkdtemp("/var/lib/kayra-owner-publication-");
  try {
    const raw: unknown = JSON.parse(await readFile(new URL("../../../ci/tests/registration-generation/ownership.json", import.meta.url), "utf8"));
    const parsed = parseRegistrationOwnership(raw); assert.ok(parsed.ok); const owner = parsed.value;
    const source = `
import json, os, sys
import registration_generation as storage
from pathlib import Path
fixture = json.loads(Path(sys.argv[2]).read_text())
owner = json.load(sys.stdin)
registration = {**fixture["registration"], "name": owner["registration"]["app"], "runtime": "swarm", "grants": {"memory_bytes": 268435456, "cpu_millicores": 500, "maintenance": False}}
root = os.open(sys.argv[1], storage._DIR_FLAGS)
try:
    storage.publish(root, owner["registration"], registration, fixture["configuration"], fixture["secrets"], 0, ownership=owner)
finally:
    os.close(root)
`;
    execFileSync("python3", ["-B", "-c", source, root, fileURLToPath(new URL("../../../ci/tests/registration-generation/fixture.json", import.meta.url))], {
      input: JSON.stringify(owner), env: { ...process.env, PYTHONPATH: fileURLToPath(new URL("../../../scripts/server-lib/", import.meta.url)) }, timeout: 10000,
    });
    const directory = join(root, "public");
    const read = () => readRegistrationOwnership(directory, owner.registration);
    assert.deepEqual(await read(), { ok: true, value: owner });
    assert.equal((await readRegistrationOwnership(directory, { ...owner.registration, actionId: owner.registration.incarnation + ":2" })).ok, false);
    const path = join(directory, createHash("sha256").update(owner.registration.app).digest("hex"), "generations", owner.registration.registrationGeneration, "ownership.json");
    await chmod(path, 0o644); assert.equal((await read()).ok, false); await chmod(path, 0o444);
    await chmod(path, 0o644); await writeFile(path, JSON.stringify({ ...owner, ownership: { ...owner.ownership, app: "other" } })); await chmod(path, 0o444);
    assert.equal((await read()).ok, false);
    await unlink(path); assert.equal((await read()).ok, false);
    const external = join(root, "external.json"); await writeFile(external, JSON.stringify(owner), { mode: 0o444 }); await symlink(external, path);
    assert.equal((await read()).ok, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
