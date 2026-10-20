import { effect, signal } from "@preact/signals";
import type { FleetFacts, OperationInfo, RunSummary, Status, Validation } from "../../cli/src/clients/wire/contract.gen.ts";
import { get, operation, runs, stream, type Failure } from "./api.ts";
import { href, parse, type Route } from "./router.ts";
import { initialTheme, themeKey, type Theme } from "./theme.ts";

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

/** Every run recorded here; a failed read keeps what was there, so the journal does not flicker. */
export const recorded = signal<Loaded<readonly RunSummary[]>>({ state: "loading" });
const loadRuns = async () => {
  const answer = await runs();
  if (answer.ok) recorded.value = { state: "ready", value: answer.value };
  else if (recorded.value.state !== "ready") recorded.value = { state: "failed", failure: answer.failure };
};

/** The runs, read again every few seconds, and the clock the pages count from. */
export const now = signal(Date.now());
export const follow = () => {
  void loadRuns();
  const timer = setInterval(() => {
    now.value = Date.now();
    void loadRuns();
  }, 3_000);
  return () => {
    clearInterval(timer);
  };
};

const stored = () => {
  try {
    return localStorage.getItem(themeKey);
  } catch {
    return null;
  }
};
const system = matchMedia("(prefers-color-scheme: dark)");
export const theme = signal<Theme>(initialTheme(stored(), system.matches));
effect(() => {
  document.documentElement.setAttribute("data-theme", theme.value);
});
system.addEventListener("change", (event) => {
  if (stored() === null) theme.value = event.matches ? "dark" : "light";
});
export const toggleTheme = () => {
  theme.value = theme.value === "dark" ? "light" : "dark";
  try {
    localStorage.setItem(themeKey, theme.value);
  } catch {
    // A browser that keeps nothing still switches, for this page.
  }
};
