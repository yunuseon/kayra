import { z } from "zod";
import { names } from "../lib/names.ts";
import { err, ok } from "../lib/result.ts";

/**
 * Metadata only. This contract does not authenticate its producer, establish
 * generation uniqueness or publication durability, or inspect files or secrets.
 */
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const record = z.object({
  version: z.literal(1),
  app: z.string().regex(names.app.pattern),
  incarnation: uuid,
  actionId: z.string(),
  registrationGeneration: uuid,
}).strict().superRefine((value, ctx) => {
  const match = /^([0-9a-f-]+):([1-9][0-9]*)$/.exec(value.actionId);
  const sequence = Number(match?.[2]);
  // Fence allocation never issues MAX_SAFE_INTEGER, because it must advance
  // its next action before the intent is persisted.
  if (match?.[1] !== value.incarnation || !Number.isSafeInteger(sequence) || sequence < 1 || sequence >= Number.MAX_SAFE_INTEGER) {
    ctx.addIssue({ code: "custom", message: "invalid lifecycle action identity" });
  }
});

export type RegistrationGeneration = Readonly<z.infer<typeof record>>;

/**
 * Parse a JSON-like manifest or current-pointer record. A future file reader
 * must bound input size before parsing. Inherited fields and accessors are not
 * metadata; copy only own data properties before handing values to the schema.
 */
export const parseRegistrationGeneration = (input: unknown) => {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return err("invalid registration generation metadata");
    const proto: unknown = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return err("invalid registration generation metadata");
    const keys = Reflect.ownKeys(input);
    const expected = ["version", "app", "incarnation", "actionId", "registrationGeneration"];
    if (keys.length !== expected.length || keys.some((key) => typeof key !== "string" || !expected.includes(key))) return err("invalid registration generation metadata");
    // eslint-disable-next-line functional/prefer-immutable-types -- these descriptors are local inspection snapshots
    const fields = keys.map((key) => [key, Object.getOwnPropertyDescriptor(input, key)] as const);
    if (fields.some(([, property]) => property === undefined || !Object.hasOwn(property, "value") || !property.enumerable)) return err("invalid registration generation metadata");
    // eslint-disable-next-line functional/prefer-immutable-types -- local snapshot is parsed and frozen before it escapes
    const snapshot = Object.fromEntries(fields.map(([key, property]) => [key, property?.value]));
    const parsed = record.safeParse(snapshot);
    return parsed.success ? ok(Object.freeze(parsed.data)) : err("invalid registration generation metadata");
  } catch {
    return err("invalid registration generation metadata");
  }
};

/**
 * Match both untrusted records to the expected lifecycle identity. A match
 * expresses equality only; a trusted owner must establish the expectation,
 * gate writers and independently verify publication and filesystem evidence.
 */
export const matchRegistrationGeneration = (manifest: unknown, pointer: unknown, expected: unknown) => {
  const records = [manifest, pointer, expected].map(parseRegistrationGeneration);
  if (records.some((result) => !result.ok)) return err("invalid registration generation metadata");
  const [first, current, wanted] = records;
  if (first === undefined || current === undefined || wanted === undefined || !first.ok || !current.ok || !wanted.ok) return err("invalid registration generation metadata");
  const same = (left: RegistrationGeneration, right: RegistrationGeneration) =>
    left.app === right.app && left.incarnation === right.incarnation &&
    left.actionId === right.actionId && left.registrationGeneration === right.registrationGeneration;
  return same(first.value, current.value) && same(first.value, wanted.value)
    ? ok(first.value) : err("registration generation identity mismatch");
};
