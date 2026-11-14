import { parseServiceInputs } from "../../contracts/service-inputs.ts";
import type { RetainedInputsPort, RuntimeInputsPort, ServiceInputs } from "../../contracts/service-inputs.ts";
import { err, ok } from "../../lib/result.ts";
import { typed } from "../../lib/typed.ts";
import { readPrivateConfiguration, readPrivateRegistration } from "./private-registration.ts";
import { readPublicRegistrationGeneration } from "./public-registration.ts";

type InputSnapshot = {
  readonly configurationIdentity: string;
  readonly configuration: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly secretKeys: readonly string[];
};
type InputReader = (reference: ServiceInputs) => Promise<InputSnapshot | undefined>;

/** Private values stay inside platform materialization; the coordinator gets only comparison outcomes. */
export const serviceInputValues = (read: InputReader) => {
  const materialize = async (input: ServiceInputs) => {
    const checked = parseServiceInputs(input); if (!checked.ok) return err("service inputs are unavailable"); const reference = checked.value;
    try {
      const snapshot = await read(reference);
      if (snapshot?.configurationIdentity !== reference.configurationIdentity ||
        snapshot.secretKeys.some((key) => Object.hasOwn(snapshot.configuration, key))) return err("service inputs are unavailable");
      const values = Object.entries(reference.environment).map(([key, binding]) => {
        if (binding.kind === "secret" && !snapshot.secretKeys.includes(binding.key)) return undefined;
        const value = binding.kind === "literal" ? binding.value : binding.kind === "configuration" ? snapshot.configuration[binding.key] : snapshot.secrets[binding.key];
        return typeof value === "string" && value.length <= 65536 && !value.includes("\0") ? typed<readonly [string, string]>([key, value]) : undefined;
      });
      if (values.some((value) => value === undefined)) return err("service inputs are unavailable");
      return ok<Readonly<Record<string, string>>>(Object.freeze(Object.fromEntries(values.filter((value) => value !== undefined))));
    } catch { return err("service inputs are unavailable"); }
  };
  const compare: RetainedInputsPort["compare"] = async (previous, candidate) => {
    const before = parseServiceInputs(previous); const after = parseServiceInputs(candidate);
    if (!before.ok || !after.ok || before.value.registration.app !== after.value.registration.app ||
      before.value.registration.incarnation !== after.value.registration.incarnation) return "unavailable";
    const [left, right] = await Promise.all([materialize(before.value), materialize(after.value)]);
    if (!left.ok || !right.ok) return "unavailable";
    const names = Object.keys(before.value.environment);
    return names.length === Object.keys(after.value.environment).length && names.every((key) =>
      JSON.stringify(before.value.environment[key]) === JSON.stringify(after.value.environment[key]) && left.value[key] === right.value[key]) ? "unchanged" : "changed";
  };
  return typed<RetainedInputsPort & RuntimeInputsPort>(Object.freeze({ materialize, compare }));
};

export const platformServiceInputs = (publicDirectory: string, privateDirectory: string, group: number) => serviceInputValues(async (reference) => {
  const registration = await readPublicRegistrationGeneration(publicDirectory, reference.registration);
  if (!registration.ok || registration.value.app.runtime !== "swarm") return undefined;
  const configuration = await readPrivateConfiguration(privateDirectory, reference.registration, group);
  if (!configuration.ok || configuration.value.identity !== reference.configurationIdentity) return undefined;
  const values = await readPrivateRegistration(privateDirectory, reference.registration, registration.value.app.secrets, group);
  if (!values.ok) return undefined;
  return Object.freeze({ configurationIdentity: configuration.value.identity, configuration: values.value.configuration,
    secrets: values.value.secrets, secretKeys: registration.value.app.secrets });
});
