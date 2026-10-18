/** Where the browser is: every page has a URL, so a reload or a shared link lands on it again. */
export type Route =
  | { readonly page: "fleet" }
  | { readonly page: "server"; readonly server: string }
  | { readonly page: "app"; readonly server: string; readonly app: string }
  | { readonly page: "runs" }
  | { readonly page: "run"; readonly id: string }
  | { readonly page: "validate" }
  | { readonly page: "missing"; readonly path: string };

const segment = /^[A-Za-z0-9._-]+$/;

export const parse = (path: string): Route => {
  const parts = path.split("/").filter((part) => part !== "").map(decodeURIComponent);
  if (!parts.every((part) => segment.test(part))) return { page: "missing", path };
  const [first, second, third, fourth] = parts;
  if (first === undefined) return { page: "fleet" };
  if (first === "runs" && second === undefined) return { page: "runs" };
  if (first === "runs" && second !== undefined && third === undefined) return { page: "run", id: second };
  if (first === "validate" && second === undefined) return { page: "validate" };
  if (first === "servers" && second !== undefined && third === undefined) return { page: "server", server: second };
  if (first === "servers" && second !== undefined && third === "apps" && fourth !== undefined && parts.length === 4)
    return { page: "app", server: second, app: fourth };
  return { page: "missing", path };
};

export const href = (route: Route): string => {
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
    case "validate":
      return "/validate";
    case "missing":
      return route.path;
  }
};
