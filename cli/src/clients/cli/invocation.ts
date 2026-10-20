import type { Invocation, OperationName } from "../../core/operations/catalog.ts";
import type { Command } from "./parser.ts";
import { typed } from "../../lib/typed.ts";

/** What the command line asks besides the operation: how its answer is printed. */
export type Asked = { readonly invocation: Invocation; readonly json: boolean };

/**
 * The parsed command line as the operation it names. `app rollback` without a
 * commit lists the releases (`app.releases`), with one it rolls back.
 */
export const fromCommand = (command: Exclude<Command, { readonly name: "serve" | "mcp" }>) => {
  const plainly = (invocation: Invocation) => typed<Asked>({ invocation, json: false });
  switch (command.name) {
    case "up":
    case "provision":
    case "deploy":
    case "setup":
    case "plan":
    case "verify":
    case "apps":
    case "hosts":
    case "down":
    case "adopt":
      return plainly({ name: command.name, input: { server: command.server } });
    case "backup test":
      return plainly({ name: "backup.test", input: { server: command.server } });
    case "ssh":
      return plainly(command.remote.length === 0 ? { name: "ssh", input: { server: command.server } } : { name: "ssh.exec", input: { server: command.server, command: command.remote } });
    case "app check":
      return plainly({ name: "app.check", input: { dir: command.dir ?? "." } });
    case "app values":
      return typed<Asked>({ invocation: { name: "app.values", input: { server: command.server, app: command.app, ...(command.dir === undefined ? {} : { dir: command.dir }) } }, json: command.json });
    case "app config set":
      return plainly({ name: "app.config.set", input: { server: command.server, app: command.app, ...(command.dir === undefined ? {} : { dir: command.dir }), key: command.key, value: command.value } });
    case "app secret import":
      return plainly({ name: "app.secret.import", input: { server: command.server, app: command.app, ...(command.dir === undefined ? {} : { dir: command.dir }), key: command.key, file: command.file } });
    case "app secret generate":
      return plainly({ name: "app.secret.generate", input: { server: command.server, app: command.app, ...(command.dir === undefined ? {} : { dir: command.dir }), key: command.key } });
    case "app purge":
      return plainly({ name: "app.purge", input: { server: command.server, app: command.app } });
    case "app runs":
      return plainly({ name: "app.runs", input: { server: command.server, app: command.app } });
    case "app logs":
      return plainly({ name: "app.log", input: { server: command.server, app: command.app, ...(command.more === undefined ? {} : { run: command.more }) } });
    case "app deploy":
      return plainly({ name: "app.deploy", input: { server: command.server, app: command.app, ...(command.more === undefined ? {} : { ref: command.more }) } });
    case "app rollback":
      return plainly(
        command.more === undefined
          ? { name: "app.releases", input: { server: command.server, app: command.app } }
          : { name: "app.rollback", input: { server: command.server, app: command.app, sha: command.more } },
      );
    case "job":
      return plainly({ name: "job", input: { server: command.server, job: command.job, noPrs: command.noPrs } });
    case "status":
      return typed<Asked>({ invocation: { name: "status", input: { offline: command.offline } }, json: command.json });
    case "validate":
      return typed<Asked>({ invocation: { name: "validate", input: command.server === undefined ? {} : { server: command.server } }, json: command.json });
    case "doctor":
      return plainly({ name: "doctor", input: {} });
    case "certs":
      return plainly({ name: "certs", input: { domain: command.domain, subdomains: command.subdomains } });
  }
};

/**
 * How the command line reaches each operation: a sample argument list
 * (SERVER and APP stand for a server and an app of the fleet). The compiler
 * refuses a catalog operation the command line does not offer; the parity
 * test parses each and checks it lands on that operation.
 */
export const reaches = {
  up: ["up", "SERVER"],
  provision: ["provision", "SERVER"],
  deploy: ["deploy", "SERVER"],
  setup: ["setup", "SERVER"],
  plan: ["plan", "SERVER"],
  verify: ["verify", "SERVER"],
  apps: ["apps", "SERVER"],
  hosts: ["hosts", "SERVER"],
  ssh: ["ssh", "SERVER"],
  "ssh.exec": ["ssh", "SERVER", "--", "uptime"],
  down: ["down", "SERVER"],
  adopt: ["adopt", "SERVER"],
  "backup.test": ["backup", "test", "SERVER"],
  "app.check": ["app", "check", "."],
  "app.values": ["app", "values", "SERVER", "APP"],
  "app.config.set": ["app", "config", "set", "SERVER", "APP", "PUBLIC_URL", "https://example.com"],
  "app.secret.import": ["app", "secret", "import", "SERVER", "APP", "API_KEY", "/tmp/credential"],
  "app.secret.generate": ["app", "secret", "generate", "SERVER", "APP", "DATABASE_PASSWORD"],
  "app.purge": ["app", "purge", "SERVER", "APP"],
  "app.runs": ["app", "runs", "SERVER", "APP"],
  "app.log": ["app", "logs", "SERVER", "APP"],
  "app.deploy": ["app", "deploy", "SERVER", "APP", "v1.2.0"],
  "app.releases": ["app", "rollback", "SERVER", "APP"],
  "app.rollback": ["app", "rollback", "SERVER", "APP", "0123abc"],
  job: ["job", "SERVER", "gc"],
  status: ["status"],
  validate: ["validate"],
  doctor: ["doctor"],
  certs: ["certs", "shop.test", "www"],
  // Optique's own: `kayra version`, `kayra --version`.
  version: ["--version"],
} as const satisfies Readonly<Record<OperationName, readonly string[]>>;
