import { deepStrictEqual, throws } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { legacyReleases } from "../../src/deployer/runs/release-read.ts";
import { commit, name } from "./support.ts";

test("legacy release projection distinguishes absent, empty, and unrecognized records", () => {
  const dir = mkdtempSync(join(tmpdir(), "kayra-release-read-"));
  const app = name("shop");
  const path = join(dir, "releases", app);
  try {
    deepStrictEqual(legacyReleases(dir, app), { hasEntries: false, releases: [] });
    mkdirSync(path, { recursive: true });
    deepStrictEqual(legacyReleases(dir, app), { hasEntries: false, releases: [] });
    writeFileSync(join(path, "unrecognized"), "");
    deepStrictEqual(legacyReleases(dir, app), { hasEntries: true, releases: [] });
    writeFileSync(join(path, `20261018T100000Z-${commit("a")}.env`), "");
    writeFileSync(join(path, `20261016T080000Z-${commit("b")}.env`), "");
    writeFileSync(join(path, `20261015T080000Z-${commit("a")}.env`), "");
    deepStrictEqual(legacyReleases(dir, app), { hasEntries: true, releases: [
      { sha: commit("a"), time: "20261018T100000Z" },
      { sha: commit("b"), time: "20261016T080000Z" },
    ] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy release projection propagates a failed directory read", () => {
  const dir = mkdtempSync(join(tmpdir(), "kayra-release-read-"));
  const app = name("shop");
  try {
    mkdirSync(join(dir, "releases"));
    writeFileSync(join(dir, "releases", app), "not a directory");
    throws(() => legacyReleases(dir, app));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
