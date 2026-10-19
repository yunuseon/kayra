import { signal } from "@preact/signals";
import type { FleetFacts, OperationInfo, Status, Validation } from "../../cli/src/clients/api/contract.gen.ts";
import { get, operation, stream, type Failure } from "./api.ts";
import { href, parse, type Route } from "./router.ts";

export const route = signal<Route>(parse(location.pathname));

export const go = (to: Route) => {
  history.pushState(null, "", href(to));
  route.value = to;
  scrollTo({ top: 0 });
};

addEventListener("popstate", () => {
  route.value = parse(location.pathname);
});

/** Something loaded from kayra: not yet, failed, or there. */
export type Loaded<T> = { readonly state: "loading" } | { readonly state: "failed"; readonly failure: Failure } | { readonly state: "ready"; readonly value: T };

export const fleet = signal<Loaded<FleetFacts>>({ state: "loading" });
export const catalog = signal<Loaded<readonly OperationInfo[]>>({ state: "loading" });
export const loadCatalog = async () => {
  const answer = await get<readonly OperationInfo[]>("/api/operations");
  catalog.value = answer.ok ? { state: "ready", value: answer.value } : { state: "failed", failure: answer.failure };
};
export const status = signal<{ readonly value: Status | undefined; readonly live: boolean }>({ value: undefined, live: false });
export const validation = signal<Loaded<Validation>>({ state: "loading" });

export const loadFleet = async () => {
  const answer = await get<FleetFacts>("/api/fleet");
  fleet.value = answer.ok ? { state: "ready", value: answer.value } : { state: "failed", failure: answer.failure };
};

/** Asks every server again: the cards fill in as the answers land. */
export const refreshStatus = () => {
  status.value = { value: status.value.value, live: true };
  stream<Status>(
    "/api/operations/status",
    (value) => {
      status.value = { value, live: true };
    },
    () => {
      status.value = { value: status.value.value, live: false };
    },
    { input: {} },
  );
};

export const loadValidation = async () => {
  validation.value = { state: "loading" };
  const answer = await operation<Validation>("validate");
  validation.value = answer.ok ? { state: "ready", value: answer.value } : { state: "failed", failure: answer.failure };
};
