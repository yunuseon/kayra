import type { ComponentChildren } from "preact";
import { href, type Route } from "../router.ts";
import { health } from "../reach.ts";
import { fleet, go, route, status } from "../state.ts";
import { Dot } from "./ui.tsx";

/** A link that moves within the app instead of reloading it. */
export const Link = ({ to, children, class: className }: { readonly to: Route; readonly children: ComponentChildren; readonly class?: string }) => (
  <a
    href={href(to)}
    class={className}
    onClick={(event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      go(to);
    }}
  >
    {children}
  </a>
);

const same = (a: Route, b: Route) => href(a) === href(b);

const NavItem = ({ to, label }: { readonly to: Route; readonly label: string }) => (
  <Link to={to} class={same(route.value, to) ? "nav-item current" : "nav-item"}>
    {label}
  </Link>
);

const Servers = () => {
  const loaded = fleet.value;
  if (loaded.state !== "ready") return null;
  const current = route.value;
  return (
    <nav class="servers" aria-label="Servers">
      <div class="nav-title">Servers</div>
      {loaded.value.servers.map((server) => (
        <Link
          key={server.name}
          to={{ page: "server", server: server.name }}
          class={"server" in current && current.server === server.name ? "nav-item current" : "nav-item"}
        >
          <Dot tone={health(status.value.value?.servers.find((each) => each.name === server.name))} />
          <span>{server.name}</span>
          <span class="nav-meta">{server.kind}</span>
        </Link>
      ))}
    </nav>
  );
};

export const Shell = ({ children }: { readonly children: ComponentChildren }) => {
  const loaded = fleet.value;
  return (
    <div class="shell">
      <aside class="sidebar">
        <Link to={{ page: "fleet" }} class="brand">
          <span class="logo" aria-hidden="true">
            k
          </span>
          <span>
            <strong>kayra</strong>
            <span class="brand-sub">{loaded.state === "ready" ? loaded.value.fleet : "…"}</span>
          </span>
        </Link>
        <nav aria-label="Pages">
          <NavItem to={{ page: "fleet" }} label="Fleet" />
          <NavItem to={{ page: "runs" }} label="Runs" />
          <NavItem to={{ page: "validate" }} label="Validate" />
        </nav>
        <Servers />
        <div class="sidebar-foot">{loaded.state === "ready" ? `kayra ${loaded.value.version}` : ""}</div>
      </aside>
      <main class="main">{children}</main>
    </div>
  );
};
