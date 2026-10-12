import { deepStrictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// Every case in golden/cases, run through kayra against the fixture fleet with
// every tool stubbed, must do exactly what golden/expected records: the same
// commands, arguments, Ansible environment, stdout and exit status. It was
// recorded from the justfiles kayra replaced; see golden/record.sh.
const golden = join(import.meta.dirname, "golden");
const out = mkdtempSync(join(tmpdir(), "kayra-golden-"));
after(() => {
  rmSync(out, { recursive: true, force: true });
});
execFileSync("bash", [join(golden, "record.sh"), out], { stdio: ["ignore", "ignore", "inherit"] });

const expected = join(golden, "expected");
readdirSync(expected).forEach((name) => {
  test(`kayra does what it did: ${name}`, () => {
    deepStrictEqual(readFileSync(join(out, name), "utf8"), readFileSync(join(expected, name), "utf8"));
  });
});
