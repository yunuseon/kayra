import { isAbsolute, relative } from "node:path";
import { Document } from "yaml";
import { names } from "../../lib/names.ts";
import { typed } from "../../lib/typed.ts";

/**
 * `kayra app init`: an existing project's compose file (or lone Dockerfile)
 * turned into what the platform deploys, without touching the project's own
 * files. What the policy refuses and can be dropped safely is dropped in an
 * overlay (`kayra/compose.yml`, Compose's `!reset`); what it builds becomes an
 * artifact (`kayra/<service>/docker/image.json`); what it publishes becomes a
 * route; what it interpolates becomes config or a secret. Whatever needs a
 * person is said, not guessed: `kayra app check` runs next and names the rest.
 */

/** `docker compose config --no-interpolate --no-env-resolution --format json`, or a lone Dockerfile. */
export type Source =
  | {
      readonly kind: "compose";
      readonly file: string;
      readonly config: unknown;
      readonly envKeys: (path: string) => readonly string[] | undefined;
      /** Whether a bind mount's source is a file: that cannot become a volume. */
      readonly isFile: (path: string) => boolean;
    }
  | { readonly kind: "dockerfile"; readonly expose: number | undefined };

export type Written = { readonly path: string; readonly content: string };
export type Init = { readonly files: readonly Written[]; readonly did: readonly string[]; readonly todo: readonly string[] };

export const overlayFile = "kayra/compose.yml";
const defaultMemory = "512m";
const defaultPort = 8080;

/** What compose-policy.sh allows on a service. */
const allowed = new Set(["image", "command", "entrypoint", "environment", "labels", "networks", "volumes", "tmpfs", "healthcheck",
  "depends_on", "restart", "user", "working_dir", "init", "read_only", "expose", "stop_grace_period", "stop_signal", "mem_limit",
  "mem_reservation", "cpus", "deploy"]);

/** Refused by the policy, and safe to drop: the platform builds, routes and names instead. */
const dropped = ["build", "ports", "env_file", "container_name", "pull_policy", "platform", "hostname"] as const;
type Dropped = (typeof dropped)[number];
const droppedKeys = new Set<string>(dropped);

const reserved = new Set(["deploy", "auth", "traefik"]);

const secretish = /PASSWORD|SECRET|TOKEN|KEY|PRIVATE|CREDENTIAL/i;

/** Variables a compose file needs and gives no default for: `${X}`, `${X:?…}`, `${X?…}`. */
const required = (text: string) =>
  Object.freeze([...text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?\?[^}]*)?\}/g)].flatMap((match) => (match[1] === undefined ? Object.freeze([]) : Object.freeze([match[1]]))));

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;

const list = (value: unknown) => (Array.isArray(value) ? typed<readonly unknown[]>(value) : typed<readonly unknown[]>([]));

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

const imageVariable = (service: string) => `${service.toUpperCase().replace(/-/g, "_")}_IMAGE`;

type Service = {
  readonly overlay: Readonly<Record<string, unknown>>;
  /** The service's volumes again, bind mounts of directories as named volumes: written with !override. */
  readonly volumes: readonly unknown[] | undefined;
  readonly named: readonly string[];
  readonly resets: readonly Dropped[];
  readonly artifacts: readonly Written[];
  readonly route: Route | undefined;
  readonly declared: readonly string[];
  readonly did: readonly string[];
  readonly todo: readonly string[];
};

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" ? "." : rel.startsWith("..") || isAbsolute(rel) ? undefined : rel;
};

type Built = { readonly written: readonly Written[]; readonly todo: readonly string[] };

const artifact = (app: string, root: string, service: string, build: unknown): Built => {
  const spec = record(build);
  const context = text(spec?.["context"]) ?? ".";
  const at = inside(root, isAbsolute(context) ? context : `${root}/${context}`);
  if (at === undefined) return { written: [], todo: [`service ${service}: its build context ${context} is outside the app; the build sees only the app's checkout`] };
  const dockerfile = text(spec?.["dockerfile"]) ?? "Dockerfile";
  const extra = ["args", "target", "secrets", "ssh", "additional_contexts"].filter((key) => spec?.[key] !== undefined);
  const manifest = { image: `${app}/${service}`, dockerfile: at === "." ? dockerfile : `${at}/${dockerfile}`, context: at, inputs: [at] };
  return {
    written: [typed<Written>({ path: `kayra/${service}/docker/image.json`, content: `${JSON.stringify(manifest, null, 2)}\n` })],
    todo: extra.map((key) => `service ${service}: build.${key} is not passed to the platform's build; bake it into the Dockerfile`),
  };
};

type Route = { readonly host: string; readonly service: string; readonly port: number };

const routeOf = (service: string, ports: readonly unknown[]): { readonly route: Route | undefined; readonly todo: readonly string[] } => {
  const tcp = ports.map(record).find((port) => port !== undefined && (text(port["protocol"]) ?? "tcp") === "tcp");
  const target = typeof tcp?.["target"] === "number" ? tcp["target"] : undefined;
  if (target === undefined) return { route: undefined, todo: [] };
  const host = service.toLowerCase();
  return names.subdomain.pattern.test(host) && !reserved.has(host)
    ? { route: { host, service, port: target }, todo: [] }
    : { route: undefined, todo: [`service ${service} publishes ${String(target)}, but ${host} is no host it may have: add its route to app.yml by hand`] };
};

/** A directory bind mount as a named volume (`<service>-<directory>`); a file's stays, for a person to bake into the image. */
type Mounts = { readonly volumes: readonly unknown[] | undefined; readonly named: readonly string[]; readonly did: readonly string[]; readonly todo: readonly string[] };

const volumesOf = (root: string, service: string, volumes: readonly unknown[], isFile: (path: string) => boolean): Mounts => {
  const mounts = volumes.map(record).flatMap((volume) => (volume === undefined ? Object.freeze([]) : Object.freeze([volume])));
  const binds = mounts.filter((volume) => volume["type"] === "bind");
  if (binds.length === 0) return { volumes: undefined, named: [], did: [], todo: [] };
  const named = (volume: Readonly<Record<string, unknown>>) =>
    `${service}-${(text(volume["source"]) ?? "data").split("/").filter((part) => part !== "").at(-1) ?? "data"}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const fileBinds = binds.filter((volume) => isFile(text(volume["source"]) ?? ""));
  const directoryBinds = binds.filter((volume) => !fileBinds.includes(volume));
  const where = (volume: Readonly<Record<string, unknown>>) => `${relative(root, text(volume["source"]) ?? "")} → ${text(volume["target"]) ?? ""}`;
  return {
    volumes: mounts
      .filter((volume) => !fileBinds.includes(volume))
      .map((volume) => (volume["type"] === "bind"
        ? { type: "volume", source: named(volume), target: volume["target"], ...(volume["read_only"] === true ? { read_only: true } : {}) }
        : volume)),
    named: directoryBinds.map(named),
    did: directoryBinds.map((volume) => `service ${service}: bind mount ${where(volume)} as the named volume ${named(volume)}; its data starts empty on the server`),
    todo: fileBinds.map((volume) => `service ${service}: bind mount of the file ${where(volume)}; COPY it into the image instead`),
  };
};

const serviceOf = (app: string, root: string, name: string, value: Readonly<Record<string, unknown>>, envKeys: (path: string) => readonly string[] | undefined, isFile: (path: string) => boolean) => {
  const builds = value["build"] !== undefined;
  const valid = /^[a-z0-9][a-z0-9-]*$/.test(name);
  const built = builds && valid ? artifact(app, root, name, value["build"]) : { written: [], todo: builds ? [`service ${name}: an image name needs lowercase letters, digits and dashes; rename the service`] : [] };
  const fromFiles = list(value["env_file"]).map((entry) => text(record(entry)?.["path"]) ?? text(entry) ?? "");
  const keys = fromFiles.map((path) => ({ path, keys: envKeys(path) }) as const);
  const envTodo = keys.filter((each) => each.keys === undefined).map((each) => `service ${name}: env_file ${relative(root, each.path)} could not be read; declare its keys in app.yml`);
  const envFromFiles = keys.flatMap((each) => each.keys ?? []);
  const { route, todo: routeTodo } = routeOf(name, list(value["ports"]));
  const deploy = record(value["deploy"]);
  const limited = value["mem_limit"] !== undefined || record(record(deploy?.["resources"])?.["limits"])?.["memory"] !== undefined;
  const mounts = volumesOf(root, name, list(value["volumes"]), isFile);
  const refused = Object.keys(value).filter((key) => !allowed.has(key) && !droppedKeys.has(key));
  const resets = dropped.filter((key) => value[key] !== undefined);
  const builtImage = built.written.length > 0;
  return typed<Service>({
    overlay: {
      ...(builtImage ? { image: `\${${imageVariable(name)}:?}` } : {}),
      ...(envFromFiles.length === 0 ? {} : { environment: Object.fromEntries(envFromFiles.map((key) => [key, `\${${key}:?}`] as const)) }),
      ...(limited ? {} : { mem_limit: defaultMemory }),
    },
    volumes: mounts.volumes,
    named: mounts.named,
    resets,
    artifacts: built.written,
    route,
    declared: envFromFiles,
    did: [
      ...(builtImage ? [`service ${name}: built by the platform from ${built.written[0]?.path ?? ""}, deployed as \${${imageVariable(name)}}`] : []),
      ...(route === undefined ? [] : [`service ${name}: route ${route.host} → ${String(route.port)} instead of its published port`]),
      ...(envFromFiles.length === 0 ? [] : [`service ${name}: ${String(envFromFiles.length)} key(s) from env_file declared in app.yml, its values never read`]),
      ...(limited ? [] : [`service ${name}: mem_limit ${defaultMemory}, since it had none`]),
      ...mounts.did,
      ...resets.filter((key) => key !== "build" && key !== "ports" && key !== "env_file").map((key) => `service ${name}: ${key} dropped`),
    ],
    todo: [
      ...built.todo,
      ...envTodo,
      ...routeTodo,
      ...mounts.todo,
      ...refused.map((key) => `service ${name}: ${key} is not allowed by the compose policy`),
      ...(route !== undefined && value["healthcheck"] === undefined ? [`service ${name}: no healthcheck; a deploy then waits only for it to start`] : []),
    ],
  });
};

const overlay = (services: readonly (readonly [string, Service])[]) => {
  const named = services.flatMap(([, service]) => service.named);
  const document = new Document({
    services: Object.fromEntries(services.map(([name, service]) => [name, service.overlay] as const)),
    ...(named.length === 0 ? {} : { volumes: Object.fromEntries(named.map((volume) => [volume, {}] as const)) }),
  });
  services.forEach(([name, service]) => {
    if (service.volumes !== undefined) {
      const node = document.createNode(service.volumes);
      // eslint-disable-next-line functional/immutable-data -- the yaml library tags a node by assignment
      node.tag = "!override";
      document.setIn(["services", name, "volumes"], node);
    }
    service.resets.forEach((key) => {
      const node = document.createNode(key === "ports" || key === "env_file" ? [] : null);
      // eslint-disable-next-line functional/immutable-data -- the yaml library tags a node by assignment
      node.tag = "!reset";
      document.setIn(["services", name, key], node);
    });
  });
  return `# Written by kayra app init: what the platform deploys on top of the project's own compose file.\n${document.toString()}`;
};

const manifest = (app: string, compose: readonly string[], routes: readonly Service["route"][], keys: readonly string[]) => {
  const secrets = keys.filter((key) => secretish.test(key));
  const config = keys.filter((key) => !secretish.test(key));
  const document = new Document({
    name: app,
    compose,
    ...(routes.length === 0 ? {} : { routes: routes.flatMap((route) => (route === undefined ? Object.freeze([]) : Object.freeze([route]))) }),
    ...(secrets.length === 0 ? {} : { secrets }),
    ...(config.length === 0 ? {} : { config }),
  });
  return `# Written by kayra app init. Review it, then: kayra app check\n${document.toString()}`;
};

/** What `app init` writes for a compose project; `root` is the app's root, absolute. */
const fromCompose = (app: string, root: string, file: string, config: unknown, envKeys: (path: string) => readonly string[] | undefined, isFile: (path: string) => boolean) => {
  const services = Object.entries(record(record(config)?.["services"]) ?? {}).flatMap(([name, value]) => {
    const service = record(value);
    return service === undefined ? Object.freeze([]) : Object.freeze([[name, serviceOf(app, root, name, service, envKeys, isFile)] as const]);
  });
  const variables = new Set(services.map(([name]) => imageVariable(name)));
  const interpolated = required(JSON.stringify(config)).filter((key) => !variables.has(key) && key !== "DOMAIN");
  const keys = [...new Set([...interpolated, ...services.flatMap(([, service]) => service.declared)])].toSorted();
  const routes = services.map(([, service]) => service.route).filter((route) => route !== undefined);
  return typed<Init>({
    files: [
      { path: "app.yml", content: manifest(app, [file, overlayFile], routes, keys) },
      { path: overlayFile, content: overlay(services) },
      ...services.flatMap(([, service]) => service.artifacts),
    ],
    did: [
      ...services.flatMap(([, service]) => service.did),
      ...(keys.length === 0 ? [] : [`declared ${keys.join(", ")}: set them with kayra app config set / app secret import|generate`]),
    ],
    todo: [
      ...services.flatMap(([, service]) => service.todo),
      ...(routes.length === 0 ? ["no service publishes a port: add a route to app.yml for the one people reach"] : []),
    ],
  });
};

/** What `app init` writes for a project with a Dockerfile and no compose file: one service, `web`. */
const fromDockerfile = (app: string, expose: number | undefined) => {
  const port = expose ?? defaultPort;
  const overlayText = new Document({ services: { web: { image: `\${${imageVariable("web")}:?}`, mem_limit: defaultMemory } } }).toString();
  return typed<Init>({
    files: [
      { path: "app.yml", content: manifest(app, [overlayFile], [{ host: "www", service: "web", port }], []) },
      { path: overlayFile, content: `# Written by kayra app init: the project's one service, built from its Dockerfile.\n${overlayText}` },
      { path: "kayra/web/docker/image.json", content: `${JSON.stringify({ image: `${app}/web`, dockerfile: "Dockerfile", context: ".", inputs: ["."] }, null, 2)}\n` },
    ],
    did: [`service web: built from ./Dockerfile, route www → ${String(port)}, mem_limit ${defaultMemory}`],
    todo: [
      ...(expose === undefined ? [`the Dockerfile EXPOSEs no port; assumed ${String(defaultPort)}, correct the route in app.yml if it listens elsewhere`] : []),
      "service web: no healthcheck; a deploy then waits only for it to start",
    ],
  });
};

export const planInit = (app: string, root: string, source: Source) =>
  source.kind === "compose" ? fromCompose(app, root, source.file, source.config, source.envKeys, source.isFile) : fromDockerfile(app, source.expose);

/** The first port a Dockerfile EXPOSEs. */
export const exposed = (dockerfile: string) => {
  const match = /^\s*EXPOSE\s+(\d+)/im.exec(dockerfile);
  return match?.[1] === undefined ? undefined : Number.parseInt(match[1], 10);
};

/** The keys of an env file, never its values. */
export const envFileKeys = (content: string) =>
  Object.freeze(content.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    return match?.[1] === undefined ? Object.freeze([]) : Object.freeze([match[1]]);
  }));

/** An app name from a directory's: lowercase, dashes for anything else. */
export const nameFrom = (directory: string) => {
  const name = directory.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "");
  return names.app.pattern.test(name) ? name : undefined;
};
