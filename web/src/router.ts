/** Where the browser is: every page has a URL, so a reload or a shared link lands on it again. */
export type Route =
  | { readonly page: "fleet" }
  | { readonly page: "server"; readonly server: string }
  | { readonly page: "app"; readonly server: string; readonly app: string }
  | { readonly page: "runs" }
  | { readonly page: "run"; readonly id: string }
  | { readonly page: "session"; readonly id: string }
  | { readonly page: "validate" }
  | { readonly page: "missing"; readonly path: string };
import { typed } from "./typed.ts";

const segment = /^[A-Za-z0-9._-]+$/;

export const parse = (path: string) => {
  const parts = path.split("/").filter((part) => part !== "").map(decodeURIComponent);
  if (!parts.every((part) => segment.test(part))) return typed<Route>({ page: "missing", path });
  const [first, second, third, fourth] = parts;
  if (first === undefined) return typed<Route>({ page: "fleet" });
  if (first === "runs" && second === undefined) return typed<Route>({ page: "runs" });
  if (first === "runs" && second !== undefined && third === undefined) return typed<Route>({ page: "run", id: second });
  if (first === "sessions" && second !== undefined && third === undefined) return typed<Route>({ page: "session", id: second });
  if (first === "validate" && second === undefined) return typed<Route>({ page: "validate" });
  if (first === "servers" && second !== undefined && third === undefined) return typed<Route>({ page: "server", server: second });
  if (first === "servers" && second !== undefined && third === "apps" && fourth !== undefined && parts.length === 4)
    return typed<Route>({ page: "app", server: second, app: fourth });
  return typed<Route>({ page: "missing", path });
};

export const href = (route: Route) => {
  switch (route.page) {
    case "fleet":
      return "/";
    case "server":
      return `/servers/${encodeURIComponent(route.server)}`;
    case "app":
      return `/servers/${encodeURIComponent(route.server)}/apps/${encodeURIComponent(route.app)}`;
    case "runs":
      return "/runs";
    case "run":
      return `/runs/${encodeURIComponent(route.id)}`;
    case "session":
      return `/sessions/${encodeURIComponent(route.id)}`;
    case "validate":
      return "/validate";
    case "missing":
      return route.path;
  }
};

/** Where a page sits, for the breadcrumb: each step back a link, the page itself the last. */
export type Crumb = { readonly label: string; readonly to?: Route };

export const trail = (route: Route) => {
  const servers = typed<Crumb>({ label: "servers", to: { page: "fleet" } });
  const runs = typed<Crumb>({ label: "runs", to: { page: "runs" } });
  const tail = (id: string) => id.split("-").at(-1) ?? id;
  switch (route.page) {
    case "fleet":
      return typed<readonly Crumb[]>([{ label: "overview" }]);
    case "server":
      return typed<readonly Crumb[]>([servers, { label: route.server }]);
    case "app":
      return typed<readonly Crumb[]>([servers, { label: route.server, to: { page: "server", server: route.server } }, { label: route.app }]);
    case "runs":
      return typed<readonly Crumb[]>([{ label: "runs" }]);
    case "run":
      return typed<readonly Crumb[]>([runs, { label: tail(route.id) }]);
    case "session":
      return typed<readonly Crumb[]>([runs, { label: `session ${tail(route.id)}` }]);
    case "validate":
      return typed<readonly Crumb[]>([{ label: "validate" }]);
    case "missing":
      return typed<readonly Crumb[]>([{ label: route.path }]);
  }
};
