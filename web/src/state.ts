import { signal } from "@preact/signals";
import type { FleetFacts, Status, Validation } from "../../cli/src/web/contract.ts";
import { get, stream, type Failure } from "./api.ts";
import { href, parse, type Route } from "./router.ts";

export const route = signal<Route>(parse(location.pathname));

export const go = (to: Route): void => {
  history.pushState(null, "", href(to));
  route.value = to;
  scrollTo({ top: 0 });
};

addEventListener("popstate", () => {
  route.value = parse(location.pathname);
});

/** Something loaded from kayra ui: not yet, failed, or there. */
export type Loaded<T> = { readonly state: "loading" } | { readonly state: "failed"; readonly failure: Failure } | { readonly state: "ready"; readonly value: T };

export const fleet = signal<Loaded<FleetFacts>>({ state: "loading" });
export const status = signal<{ readonly value: Status | undefined; readonly live: boolean }>({ value: undefined, live: false });
export const validation = signal<Loaded<Validation>>({ state: "loading" });

export const loadFleet = async (): Promise<void> => {
  const answer = await get<FleetFacts>("/api/fleet");
  fleet.value = answer.ok ? { state: "ready", value: answer.value } : { state: "failed", failure: answer.failure };
};

/** Asks every server again: the cards fill in as the answers land. */
export const refreshStatus = (): void => {
  status.value = { value: status.value.value, live: true };
  stream<Status>(
    "/api/status",
    (value) => {
      status.value = { value, live: true };
    },
    () => {
      status.value = { value: status.value.value, live: false };
    },
  );
};

export const loadValidation = async (): Promise<void> => {
  validation.value = { state: "loading" };
  const answer = await get<Validation>("/api/validate");
  validation.value = answer.ok ? { state: "ready", value: answer.value } : { state: "failed", failure: answer.failure };
};
