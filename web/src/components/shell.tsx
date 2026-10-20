import type { ComponentChildren } from "preact";
import { href, trail, type Route } from "../router.ts";
import { health, kayra, verdict } from "../reach.ts";
import { fleet, go, now, route, status, theme, toggleTheme } from "../state.ts";
import { show } from "./operation.tsx";
import { openPalette } from "./palette.tsx";
import { Dot } from "./ui.tsx";

/** A link that moves within the app instead of reloading it. */
export const Link = ({ to, children, class: className, current }: { readonly to: Route; readonly children: ComponentChildren; readonly class?: string; readonly current?: boolean }) => (
  <a
    href={href(to)}
    class={className}
    aria-current={current === true ? "page" : undefined}
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

const Mark = () => (
  <svg class="logo" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
    <rect width="22" height="22" rx="5" />
    <path d="M6.5 7l4 4-4 4M12 15.5h4" />
  </svg>
);

const Sun = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
  </svg>
);

const Moon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
    <path d="M13.5 9.6A5.6 5.6 0 0 1 6.4 2.5a5.6 5.6 0 1 0 7.1 7.1z" />
  </svg>
);

const Topbar = () => {
  const loaded = fleet.value;
  const crumbs = trail(route.value);
  const dark = theme.value === "dark";
  return (
    <header class="topbar">
      <Link to={{ page: "fleet" }} class="brand">
        <Mark />
        <span>
          kayra<span class="cursor" aria-hidden="true">▌</span>
        </span>
      </Link>
      <span class="slash" aria-hidden="true">/</span>
      <span class="fleet-name" title="The fleet kayra serve was started in">
        {loaded.state === "ready" ? loaded.value.fleet : "…"}
      </span>
      <span class="slash" aria-hidden="true">/</span>
      <nav class="crumbs" aria-label="Breadcrumb">
        {crumbs.map((crumb, index) => (
          <span key={crumb.label} class="crumb">
            {index === 0 ? null : <span class="slash" aria-hidden="true">/</span>}
            {crumb.to === undefined ? <span aria-current="page">{crumb.label}</span> : <Link to={crumb.to}>{crumb.label}</Link>}
          </span>
        ))}
      </nav>
      <span class="spacer" />
      <button type="button" class="cmdbar" onClick={openPalette}>
        <span class="prompt" aria-hidden="true">❯</span>
        <span>run a command or jump to…</span>
        <kbd>⌘K</kbd>
      </button>
      <button type="button" class="iconbtn" onClick={toggleTheme} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"} title={dark ? "Light mode" : "Dark mode"}>
        {dark ? <Sun /> : <Moon />}
      </button>
    </header>
  );
};

const RailTitle = ({ children, count }: { readonly children: string; readonly count?: number | undefined }) => (
  <div class="rail-title">
    <span>{children}</span>
    <span class="rule" aria-hidden="true" />
    {count === undefined ? null : <span>{count}</span>}
  </div>
);

const View = ({ to, label }: { readonly to: Route; readonly label: string }) => {
  const here = same(route.value, to);
  return (
    <Link to={to} class={here ? "rail-item on" : "rail-item"} current={here}>
      <span class="rail-mark" aria-hidden="true">{here ? "›" : ""}</span>
      <span>{label}</span>
    </Link>
  );
};

const Rail = () => {
  const loaded = fleet.value;
  const current = route.value;
  const seen = status.value.value?.servers;
  return (
    <div class="rail">
      <div class="rail-inner">
        <nav aria-label="Servers">
          <RailTitle count={loaded.state === "ready" ? loaded.value.servers.length : undefined}>servers</RailTitle>
          {loaded.state === "ready"
            ? loaded.value.servers.map((server) => {
                const here = "server" in current && current.server === server.name;
                const state = verdict(seen?.find((each) => each.name === server.name));
                return (
                  <Link key={server.name} to={{ page: "server", server: server.name }} class={here ? "rail-item on" : "rail-item"} current={here && current.page === "server"}>
                    <Dot tone={state.tone} label={state.word.toLowerCase()} />
                    <span class="name">{server.name}</span>
                    <span class="meta">{server.kind}</span>
                  </Link>
                );
              })
            : null}
        </nav>
        <nav aria-label="Pages">
          <RailTitle>views</RailTitle>
          <View to={{ page: "fleet" }} label="overview" />
          <View to={{ page: "runs" }} label="runs" />
          <View to={{ page: "validate" }} label="validate" />
          <button
            type="button"
            class="rail-item"
            onClick={() => {
              show({ name: "doctor" });
            }}
          >
            <span class="rail-mark" aria-hidden="true" />
            <span>doctor</span>
          </button>
        </nav>
      </div>
    </div>
  );
};

const mode: Readonly<Record<Route["page"], string>> = {
  fleet: "FLEET",
  server: "SERVER",
  app: "APP",
  runs: "RUNS",
  run: "RUN",
  session: "SSH",
  validate: "VALIDATE",
  missing: "?",
};

const Statusline = () => {
  const loaded = fleet.value;
  const { value: seen, live } = status.value;
  const servers = seen?.servers ?? [];
  const answering = servers.filter((server) => health(server) === "ok").length;
  const behind = servers.filter((server) => kayra(server).tone === "warn").length;
  const clock = new Date(now.value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <footer class="statusline">
      <span class="seg seg-mode">{mode[route.value.page]}</span>
      <span class="seg">{loaded.state === "ready" ? loaded.value.fleet : "…"}</span>
      <span class="seg">kayra {loaded.state === "ready" ? loaded.value.version : "…"}</span>
      <span class="seg wide-only">
        <Dot tone="ok" />
        real servers ask for their name
      </span>
      <span class="spacer" />
      <span class="seg end">
        {live ? (
          <>
            <Dot tone="waiting" /> asking
          </>
        ) : (
          `${String(answering)}/${String(servers.length)} answering`
        )}
        {behind === 0 ? null : <span class="tone-warn"> · {behind} behind</span>}
      </span>
      <span class="seg end wide-only">{location.host}</span>
      <span class="seg end">{clock}</span>
    </footer>
  );
};

export const Shell = ({ children }: { readonly children: ComponentChildren }) => (
  <div class="app">
    <Topbar />
    <div class="body">
      <Rail />
      <main class="main">{children}</main>
    </div>
    <Statusline />
  </div>
);
