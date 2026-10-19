import type { Domain, Subdomain } from "../fleet/brand.ts";
import type { Plan } from "../plan/model.ts";
import { ok } from "../../result.ts";
import { certs, type Engine } from "./steps.ts";

/** mkcert certs for a domain and its subdomains, for local dev and multipass. */
export const certsFor = (engine: Engine, domain: Domain, subdomains: readonly Subdomain[]) =>
  ok<Plan>([certs(engine, domain, subdomains)]);
