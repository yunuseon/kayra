import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { absolutePath, ageKeyFile, fleetRoot, serverDir, serverName } from "../src/core/fleet/brand.ts";
import { parseServer } from "../src/core/fleet/parse.ts";
import type { Fleet, Server, ServerFiles } from "../src/core/fleet/model.ts";
import type { Result } from "../src/lib/result.ts";

export const must = <T>(result: Result<T, string>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

export const root = fleetRoot(must(absolutePath("/fleet")));

/** A server's files as a valid real server has them, unless overridden. */
export const files = (name: string, descriptor: string, overrides: Partial<ServerFiles> = {}): ServerFiles => {
  const brandedName = must(serverName(name));
  return {
    name: brandedName,
    dir: serverDir(root, brandedName),
    descriptor,
    vars: "",
    secrets: "token: ENC[AES256_GCM,data:AA==,iv:AA==,tag:AA==,type:str]\nsops:\n    age:\n        - recipient: age1test\n",
    inventory: `[servers]\n${name} ansible_host=192.0.2.9 ansible_user=deploy ansible_ssh_private_key_file=/keys/${name}\n`,
    hasTerraform: true,
    stacks: [],
    appValues: [],
    ...overrides,
  };
};

export const server = (name: string, descriptor: string, overrides: Partial<ServerFiles> = {}): Server =>
  must(parseServer(files(name, descriptor, overrides)));

export const fleet = (...servers: readonly Server[]): Fleet => ({ root, servers });

/** The tests' own age identity (fixtures/age-key.txt): it opens only what the tests encrypt to it. */
export const testKey = ageKeyFile(must(absolutePath(fileURLToPath(new URL("fixtures/age-key.txt", import.meta.url)))));
export const testRecipient = "age1wft9wjn3wjlyx36208t8led6haveep4ls6wp8yvu5s8hvycwz5ms75qpz5";

/** YAML written to `file`, encrypted by SOPS to the tests' key. */
export const sealed = (file: string, plaintext: string) => {
  writeFileSync(file, plaintext);
  execFileSync("sops", ["encrypt", "--in-place", "--age", testRecipient, "--input-type", "yaml", "--output-type", "yaml", file], { stdio: "pipe" });
  return file;
};
