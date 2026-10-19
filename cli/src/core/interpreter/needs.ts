import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Env, Need } from "../plan/model.ts";
import { active, muted, strong } from "../text/spans.ts";
import { ask, type Io, type Question } from "./io.ts";
import { spawned, type Plumbing, type Stdin } from "./process.ts";

/**
 * A step's needs, met: the vault password through Ansible's password-file
 * hook (a script printing it from the step's environment, so it never touches
 * disk), sudo's on the step's stdin where none is cached.
 */
export type Met = { readonly env: Env; readonly stdin?: Stdin };

/** The answers given in this run, by need: each asked once. */
export type Given = Readonly<Record<string, string>>;

const keyOf = (need: Need): string => (need.kind === "vault" ? `vault:${need.server}` : "sudo");

const questionOf = (need: Need): Question =>
  need.kind === "vault"
    ? { kind: "secret", text: ["  ", active("?"), " ", strong(`${need.server}'s vault password`), muted(" (asked once, kept for this run): ")] }
    : { kind: "secret", text: ["  ", active("?"), " ", strong("sudo's password"), muted(" (for this step only): ")] };

/** Whether sudo would run without a password: a cached one, or none needed. */
const sudoReady = async (plumbing: Plumbing): Promise<boolean> =>
  (await spawned(["sudo", "-n", "true"], { stdout: "discard", stderr: "capture", stdin: { kind: "none" } }, {}, plumbing)).code === 0;

/** The vault password script, made once per run in a directory only this user reads. */
type Scratch = { readonly vaultScript: () => string; readonly clean: () => void };

export const scratch = (): Scratch => {
  // eslint-disable-next-line functional/prefer-immutable-types -- made on first need, removed when the run ends
  const made: { dir?: string } = {};
  const dir = (): string => {
    // eslint-disable-next-line functional/immutable-data -- see above
    made.dir ??= mkdtempSync(join(tmpdir(), "kayra-"));
    return made.dir;
  };
  return {
    vaultScript: () => {
      const script = join(dir(), "vault-password");
      writeFileSync(script, '#!/bin/sh\nprintf \'%s\\n\' "$KAYRA_VAULT_PASSWORD"\n', { mode: 0o700 });
      chmodSync(script, 0o700);
      return script;
    },
    clean: () => {
      if (made.dir !== undefined) rmSync(made.dir, { recursive: true, force: true });
    },
  };
};

/** Asks what a step needs and has not been given yet in this run; undefined if the operator gave nothing. */
export const meet = async (needs: readonly Need[], asked: Given, io: Io, made: Scratch): Promise<{ readonly met: Met; readonly asked: Given } | undefined> =>
  needs.reduce<Promise<{ readonly met: Met; readonly asked: Given } | undefined>>(async (previous, need) => {
    const so = await previous;
    if (so === undefined) return undefined;
    if (need.kind === "sudo" && (await sudoReady(io))) return so;
    const key = keyOf(need);
    const given = so.asked[key] ?? (await ask(io, questionOf(need)));
    if (given === "") return undefined;
    const now = need.kind === "vault" ? { ...so.asked, [key]: given } : so.asked;
    return need.kind === "vault"
      ? { asked: now, met: { ...so.met, env: { ...so.met.env, ANSIBLE_VAULT_PASSWORD_FILE: made.vaultScript(), KAYRA_VAULT_PASSWORD: given } } }
      : { asked: now, met: { env: { ...so.met.env, KAYRA_SUDO_STDIN: "1" }, stdin: { kind: "given", text: `${given}\n` } } };
  }, Promise.resolve({ met: { env: {} }, asked }));
