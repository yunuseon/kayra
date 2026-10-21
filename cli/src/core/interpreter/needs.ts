import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textAt } from "../adapters/fs.ts";
import { sops } from "../adapters/sops.ts";
import { terraformVariables } from "../fleet/secrets.ts";
import type { Env, Need } from "../plan/model.ts";
import { active, muted, strong } from "../text/spans.ts";
import { ask, type Io, type Question } from "./io.ts";
import { spawned, type Plumbing, type Stdin } from "./process.ts";
import { err, flatMap, map, mapError, ok, type Result } from "../../lib/result.ts";
import { typed } from "../../lib/typed.ts";
import { fields } from "../../lib/yaml.ts";

/**
 * A step's needs, met: a server's secrets.yml opened once per run (for
 * Ansible a plaintext copy in the run's private directory, named by
 * KAYRA_SECRETS; for OpenTofu its terraform mapping as TF_VAR_*), sudo's
 * password on the step's stdin where none is cached.
 */
export type Met = { readonly env: Env; readonly stdin?: Stdin };

/** What this run has met so far, by need: sudo's answer, and where each server's opened secrets.yml is. */
export type Given = Readonly<Record<string, string>>;

const sudoQuestion = typed<Question>({ kind: "secret", text: ["  ", active("?"), " ", strong("sudo's password"), muted(" (for this step only): ")] });

/** Whether sudo would run without a password: a cached one, or none needed. */
const sudoReady = async (plumbing: Plumbing) =>
  (await spawned(["sudo", "-n", "true"], { stdout: "discard", stderr: "capture", stdin: { kind: "none" } }, {}, plumbing)).code === 0;

/** The run's private directory (only this user reads it), made on first need and removed when the run ends. */
type Scratch = { readonly write: (name: string, text: string) => string; readonly clean: () => void };

export const scratch = () => {
  // eslint-disable-next-line functional/prefer-immutable-types -- made on first need, removed when the run ends
  const made: { dir?: string } = {};
  return typed<Scratch>({
    write: (name, text) => {
      // eslint-disable-next-line functional/immutable-data -- see above
      made.dir ??= mkdtempSync(join(tmpdir(), "kayra-"));
      const file = join(made.dir, name);
      writeFileSync(file, text, { mode: 0o600 });
      return file;
    },
    clean: () => {
      if (made.dir !== undefined) rmSync(made.dir, { recursive: true, force: true });
    },
  });
};

type SecretsNeed = Extract<Need, { readonly kind: "secrets" }>;

/** Where this run has secrets.yml in plaintext: opened once (one Touch ID, where the key asks for it), then reused. */
const opened = async (need: SecretsNeed, given: Given, made: Scratch, plumbing: Plumbing) => {
  const cached = given[`secrets:${need.server}`];
  if (cached !== undefined) return ok(cached);
  if (!need.encrypted) return ok<string>(need.file);
  return map(await sops.decrypt(need.file, need.key, plumbing), (text) => made.write(`${need.server}.secrets.yml`, text));
};

const secretsEnv = (need: SecretsNeed, file: string) => {
  if (need.for === "ansible") return ok<Env>({ KAYRA_SECRETS: file });
  const text = textAt(file);
  return text === undefined ? err(`cannot read ${file}`) : flatMap(mapError(fields(text), (why) => `${file} ${why}`), terraformVariables);
};

/** What a run has met so far. */
type Meeting = { readonly met: Met; readonly given: Given };

/** How meeting a step's needs went: met, declined (the operator gave nothing), or failed. */
export type Meet = { readonly kind: "met"; readonly meeting: Meeting } | { readonly kind: "declined" } | { readonly kind: "failed"; readonly why: string };

const meetOne = async (so: Meeting, need: Need, io: Io, made: Scratch): Promise<Result<Meeting | undefined, string>> => {
  if (need.kind === "secrets") {
    const file = await opened(need, so.given, made, io);
    if (!file.ok) return file;
    const env = secretsEnv(need, file.value);
    if (!env.ok) return env;
    return ok({ given: { ...so.given, [`secrets:${need.server}`]: file.value }, met: { ...so.met, env: { ...so.met.env, ...env.value } } });
  }
  if (await sudoReady(io)) return ok(so);
  const given = await ask(io, sudoQuestion);
  // An empty password is none: Enter alone declines.
  if (given === undefined || given === "") return ok(undefined);
  return ok({ given: so.given, met: { env: { ...so.met.env, KAYRA_SUDO_STDIN: "1" }, stdin: { kind: "given", text: `${given}\n` } } });
};

/** Meets what a step needs and this run has not met yet. */
export const meet = async (needs: readonly Need[], given: Given, io: Io, made: Scratch) => {
  const ended = await needs.reduce<Promise<Result<Meeting | undefined, string>>>(async (previous, need) => {
    const so = await previous;
    return !so.ok || so.value === undefined ? so : meetOne(so.value, need, io, made);
  }, Promise.resolve(ok<Meeting | undefined>({ met: { env: {} }, given })));
  if (!ended.ok) return typed<Meet>({ kind: "failed", why: ended.error });
  return ended.value === undefined ? typed<Meet>({ kind: "declined" }) : typed<Meet>({ kind: "met", meeting: ended.value });
};
