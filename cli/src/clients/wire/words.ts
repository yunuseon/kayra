import type { Invocation } from "../../core/operations/catalog.ts";

/** What follows the server and the app on the command line, by operation. */
const extra = (call: Invocation) => {
  switch (call.name) {
    case "app.build":
      return [call.input.commit];
    case "app.deployment.prepare":
      return [call.input.commit, call.input.request];
    case "app.deployment.cancel":
      return [call.input.request];
    case "app.migration.cleanup":
      return [call.input.run, call.input.step, call.input.purpose, String(call.input.attempt), call.input.action, "--reason", JSON.stringify(call.input.reason)];
    case "app.migration.cleanup.audit":
    case "app.migration.audit":
      return [call.input.run, call.input.step];
    case "app.migration.resolve":
      return [call.input.run, call.input.step, call.input.outcome, "--reason", JSON.stringify(call.input.reason)];
    case "app.config.set":
      return [call.input.key, call.input.value, ...(call.input.dir === undefined ? [] : ["--dir", call.input.dir])];
    case "app.secret.import":
      return [call.input.key, call.input.file, ...(call.input.dir === undefined ? [] : ["--dir", call.input.dir])];
    case "app.secret.generate":
      return [call.input.key, ...(call.input.dir === undefined ? [] : ["--dir", call.input.dir])];
    case "app.values":
      return call.input.dir === undefined ? [] : ["--dir", call.input.dir];
    case "app.hook":
      return [];
    case "app.launch":
      return (["repo", "ref", "path", "dir"] as const).flatMap((key) => (call.input[key] === undefined ? [] : [`--${key}`, call.input[key]]));
    case "ssh.exec":
      return ["--", ...call.input.command];
    case "job":
      return [call.input.job, ...(call.input.noPrs ? ["--no-prs"] : [])];
    case "app.rollback":
      return [call.input.sha];
    case "app.deploy":
      return call.input.ref === undefined ? [] : [call.input.ref];
    case "app.log":
      return call.input.run === undefined ? [] : [call.input.run];
    case "app.check":
      return [call.input.dir];
    case "app.init":
      return [call.input.dir, ...(call.input.name === undefined ? [] : ["--name", call.input.name])];
    case "certs":
      return [call.input.domain, ...call.input.subdomains];
    case "up":
    case "provision":
    case "deploy":
    case "setup":
    case "plan":
    case "verify":
    case "apps":
    case "hosts":
    case "ssh":
    case "down":
    case "adopt":
    case "backup.test":
    case "app.purge":
    case "app.deployment.pins":
    case "app.deployment.status":
    case "app.runs":
    case "app.releases":
    case "status":
    case "validate":
    case "doctor":
    case "version":
      return [];
  }
};

/** How the command line spells an operation where its words are not its name's. */
const spelled: Partial<Readonly<Record<Invocation["name"], string>>> = { "app.migration.cleanup.audit": "app migration cleanup-audit", "ssh.exec": "ssh", "app.releases": "app rollback", "app.log": "app logs" };

/** The command's words, as typed on the command line. */
export const words = (call: Invocation) => {
  const { input } = call;
  const scope = ["server" in input ? input.server : undefined, "app" in input ? input.app : undefined];
  const name = spelled[call.name] ?? call.name.replaceAll(".", " ");
  return ["kayra", name, ...scope, ...extra(call)].filter((word) => word !== undefined).join(" ");
};
