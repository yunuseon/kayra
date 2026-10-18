import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { onServer, reaches, type Draft } from "../operations.ts";
import { ranked, type Choice } from "../fuzzy.ts";
import type { Route } from "../router.ts";
import { catalog, fleet, go } from "../state.ts";
import { openOperation } from "./operation.tsx";

const open = signal(false);

type Item = Choice & ({ readonly go: Route } | { readonly run: Draft });

/** Everything there is to go to or run: pages, servers, apps, and each server's commands. */
const items = (): readonly Item[] => {
  const loaded = fleet.value;
  const servers = loaded.state === "ready" ? loaded.value.servers : [];
  const operations = catalog.value.state === "ready" ? catalog.value.value : [];
  return [
    { label: "Fleet", hint: "every server", go: { page: "fleet" } },
    { label: "Runs", hint: "what ran from here", go: { page: "runs" } },
    { label: "Validate", hint: "the fleet beyond its schemas", go: { page: "validate" } },
    ...operations.map((operation): Item => ({ label: `${operation.name} · ${reaches[operation.name].label}`, hint: operation.summary, run: { name: operation.name, input: {} } })),
    ...servers.flatMap((server): readonly Item[] => [
      { label: server.name, hint: `${server.kind} on ${server.target}`, go: { page: "server", server: server.name } },
      ...server.apps.map((app): Item => ({ label: `${server.name}/${app}`, hint: "app", go: { page: "app", server: server.name, app } })),
      ...onServer(operations, server).map((operation): Item => ({ label: `${operation.name} ${server.name}`, hint: operation.summary, run: { name: operation.name, input: { server: server.name } } })),
    ]),
  ];
};

const choose = (item: Item): void => {
  open.value = false;
  if ("go" in item) go(item.go);
  else openOperation(item.run.name, item.run.input);
};

/** ⌘K: go anywhere, run anything, by typing a few letters of it. */
export const Palette = () => {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const shownNow = open.value;
  // Preact does not focus an autoFocus input that appears later: focus it when the palette opens.
  useEffect(() => {
    if (shownNow) input.current?.focus();
  }, [shownNow]);
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        open.value = !open.value;
        setQuery("");
        setSelected(0);
      } else if (event.key === "Escape") open.value = false;
    };
    addEventListener("keydown", key);
    return () => {
      removeEventListener("keydown", key);
    };
  }, []);
  if (!open.value) return null;
  const shown = ranked(items(), query).slice(0, 12);
  return (
    <div class="overlay" onClick={() => { open.value = false; }}>
      <div class="palette" role="dialog" aria-modal="true" onClick={(event) => { event.stopPropagation(); }}>
        <input
          ref={input}
          value={query}
          placeholder="Go to, or run…"
          spellcheck={false}
          onInput={(event) => {
            setQuery(event.currentTarget.value);
            setSelected(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") setSelected(Math.min(selected + 1, shown.length - 1));
            else if (event.key === "ArrowUp") setSelected(Math.max(selected - 1, 0));
            else if (event.key === "Enter") {
              const item = shown[selected];
              if (item !== undefined) choose(item);
            } else return;
            event.preventDefault();
          }}
        />
        <ul>
          {shown.map((item, index) => (
            <li key={item.label} class={index === selected ? "selected" : undefined} onMouseEnter={() => { setSelected(index); }} onClick={() => { choose(item); }}>
              <span>{item.label}</span>
              <span class="hint">{item.hint}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

export const openPalette = (): void => {
  open.value = true;
};
