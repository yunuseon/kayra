import { typed } from "../../lib/typed.ts";
import type { ApplicationPlan } from "../../contracts/http-plan.ts";
import { parseApplicationPlan } from "../../contracts/application-plan.ts";
import { readPrivateConfiguration, readPrivateRegistration } from "./private-registration.ts";
import { readPublicRegistrationGeneration } from "./public-registration.ts";

/** Platform secrets are resolved only at the runtime boundary, from the exact admitted generation. */
export const httpEnvironment = (publicDirectory: string, privateDirectory: string, group: number) => Object.freeze({
  materialize: async (input: ApplicationPlan) => {
    const checked = parseApplicationPlan(input);
    if (!checked.ok) throw new Error("invalid HTTP plan inputs");
    const plan = checked.value;
    const registration = await readPublicRegistrationGeneration(publicDirectory, plan.registration);
    if (!registration.ok || registration.value.app.runtime !== "swarm" || JSON.stringify(registration.value.app.grants) !== JSON.stringify(plan.grants) || plan.routes.some((route) => !registration.value.app.hosts.includes(route.host))) throw new Error("HTTP registration inputs are unavailable");
    const configuration = await readPrivateConfiguration(privateDirectory, plan.registration, group);
    if (!configuration.ok || configuration.value.identity !== plan.configurationIdentity) throw new Error("HTTP configuration identity changed");
    const values = await readPrivateRegistration(privateDirectory, plan.registration, registration.value.app.secrets, group);
    if (!values.ok) throw new Error("HTTP private inputs are unavailable");
    const service = Object.values(plan.services)[0];
    if (service === undefined) throw new Error("HTTP plan has no service");
    return Object.freeze(Object.fromEntries(Object.entries(service.environment).map(([key, binding]) => {
      const value = binding.kind === "literal" ? binding.value : binding.kind === "secret" ? values.value.secrets[binding.key] : values.value.configuration[binding.key];
      if (value === undefined || value.includes("\0")) throw new Error("HTTP input binding is unavailable");
      return typed<readonly [string, string]>([key, value]);
    })));
  },
});
