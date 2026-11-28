import { names } from "../lib/names.ts";
import { err, ok } from "../lib/result.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type RegistrationGeneration = {
  readonly version: 1;
  readonly app: string;
  readonly incarnation: string;
  readonly actionId: string;
  readonly registrationGeneration: string;
};
export type RegistrationObservation = Readonly<Omit<RegistrationGeneration, "version"> & { readonly status: "applied" | "not-applied" | "unknown" }>;

const metadataKeys = ["version", "app", "incarnation", "actionId", "registrationGeneration"] as const;
const dataProperties = (input: unknown, expected: readonly string[]) => {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
    const proto: unknown = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return undefined;
    const keys = Reflect.ownKeys(input);
    if (keys.length !== expected.length || keys.some((key) => typeof key !== "string" || !expected.includes(key))) return undefined;
    // eslint-disable-next-line functional/prefer-immutable-types -- local descriptors never escape
    const fields = keys.map((key) => [key, Object.getOwnPropertyDescriptor(input, key)] as const);
    if (fields.some(([, property]) => property === undefined || !Object.hasOwn(property, "value") || !property.enumerable)) return undefined;
    return Object.freeze(Object.fromEntries(fields.map(([key, property]) => {
      const value: unknown = property?.value;
      return [key, value] as const;
    })));
  } catch {
    return undefined;
  }
};

/**
 * Parse a JSON-like manifest or current-pointer record. A future file reader
 * must bound input size before parsing. Inherited fields and accessors are not
 * metadata; only own data properties are accepted.
 */
export const parseRegistrationGeneration = (input: unknown) => {
  const fields = dataProperties(input, metadataKeys);
  if (fields === undefined) return err("invalid registration generation metadata");
  const { version, app, incarnation, actionId, registrationGeneration } = fields;
  if (version !== 1 || typeof app !== "string" || !names.app.pattern.test(app) ||
    typeof incarnation !== "string" || !uuid.test(incarnation) ||
    typeof registrationGeneration !== "string" || !uuid.test(registrationGeneration) ||
    typeof actionId !== "string") return err("invalid registration generation metadata");
  const match = /^([0-9a-f-]+):([1-9][0-9]*)$/.exec(actionId);
  const sequence = Number(match?.[2]);
  if (match?.[1] !== incarnation || !Number.isSafeInteger(sequence) ||
    sequence < 1 || sequence >= Number.MAX_SAFE_INTEGER) return err("invalid registration generation metadata");
  return ok<RegistrationGeneration>(Object.freeze({ version, app, incarnation, actionId, registrationGeneration }));
};

/** Identity-bound evidence from a trusted platform observer. Parsing alone does
 * not establish its authority, durability or freshness under the app fence. */
export const parseRegistrationObservation = (input: unknown) => {
  const value = dataProperties(input, ["app", "incarnation", "actionId", "registrationGeneration", "status"]);
  if (value === undefined) return err("invalid registration observation");
  const metadata = parseRegistrationGeneration({ version: 1, app: value["app"], incarnation: value["incarnation"], actionId: value["actionId"], registrationGeneration: value["registrationGeneration"] });
  const status = value["status"];
  if (!metadata.ok || (status !== "applied" && status !== "not-applied" && status !== "unknown")) return err("invalid registration observation");
  const { app, incarnation, actionId, registrationGeneration } = metadata.value;
  return ok<RegistrationObservation>(Object.freeze({ app, incarnation, actionId, registrationGeneration, status }));
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
