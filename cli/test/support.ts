import { absolutePath, fleetRoot, serverDir, serverName } from "../src/core/brand.ts";
import { parseServer, type Fleet, type Server, type ServerFiles } from "../src/core/fleet.ts";
import type { Result } from "../src/result.ts";

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
    secrets: "$ANSIBLE_VAULT;1.1;AES256\n",
    inventory: `[servers]\n${name} ansible_host=192.0.2.9 ansible_user=deploy ansible_ssh_private_key_file=/keys/${name}\n`,
    terraform: true,
    stacks: [],
    appValues: [],
    ...overrides,
  };
};

export const server = (name: string, descriptor: string, overrides: Partial<ServerFiles> = {}): Server =>
  must(parseServer(files(name, descriptor, overrides)));

export const fleet = (...servers: readonly Server[]): Fleet => ({ root, servers });
