import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import type { OperationInfo } from "../../../cli/src/clients/wire/contract.gen.ts";
import { onServer, reaches, type Draft } from "../operations.ts";
import { ranked, type Choice } from "../fuzzy.ts";
import type { Route } from "../router.ts";
import { catalog, fleet, go } from "../state.ts";
import { openOperation } from "./operation.tsx";
import { typed } from "../typed.ts";

const open = signal(false);

/** Where an item leads and what it does: a page to go to, or a command with its effect and the line the CLI would take. */
type Item = Choice & { readonly icon: string; readonly line: string } & (
    | { readonly go: Route }
    | { readonly run: Draft; readonly effect: OperationInfo["effect"]; readonly real: boolean }
  );

const words = (name: OperationInfo["name"]) => name.replace(".", " ");

/** Everything there is to go to or run: pages, servers, apps, and each server's commands. */
const items = () => {
  const loaded = fleet.value;
  const servers = loaded.state === "ready" ? loaded.value.servers : [];
  const operations = catalog.value.state === "ready" ? catalog.value.value : [];
  return typed<readonly Item[]>([
    { label: "overview", hint: "every server", icon: "›", line: "open /", go: { page: "fleet" } },
    { label: "runs", hint: "what ran from here", icon: "›", line: "open /runs", go: { page: "runs" } },
    { label: "validate", hint: "the fleet beyond its schemas", icon: "›", line: "open /validate", go: { page: "validate" } },
    ...operations
      .filter((operation) => operation.scope === "fleet" || operation.scope === "repo")
      .map((operation) =>
        typed<Item>({ label: words(operation.name), hint: operation.summary, icon: reaches[operation.name].icon, line: `kayra ${words(operation.name)}`, run: { name: operation.name, input: {} }, effect: operation.effect, real: false }),
      ),
    ...servers.flatMap((server) =>
      typed<readonly Item[]>([
        { label: server.name, hint: `${server.kind} on ${server.target} · ${server.domain}`, icon: "●", line: `open /servers/${server.name}`, go: { page: "server", server: server.name } },
        ...server.apps.map((app) =>
          typed<Item>({ label: `${server.name}/${app}`, hint: "app", icon: "▸", line: `open /servers/${server.name}/apps/${app}`, go: { page: "app", server: server.name, app } }),
        ),
        ...onServer(operations, server).map((operation) =>
          typed<Item>({
            label: `${words(operation.name)} ${server.name}`,
            hint: operation.summary,
            icon: reaches[operation.name].icon,
            line: `kayra ${words(operation.name)} ${server.name}`,
            run: { name: operation.name, input: { server: server.name } },
            effect: operation.effect,
            real: server.target !== "multipass",
          }),
        ),
      ]),
    ),
  ]);
};

const badge = (item: Item) => {
  if ("go" in item) return { text: "jump", class: "badge badge-jump", guard: "opens it" };
  if (item.effect === "reads") return { text: "read only", class: "badge badge-reads", guard: "reads, changes nothing" };
  const guard = item.real ? "shows its plan, then asks for the server's name" : "shows its plan first";
  return item.effect === "destroys" ? { text: "destroys", class: "badge badge-destroys", guard } : { text: "changes", class: "badge badge-changes", guard };
};

const choose = (item: Item) => {
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
    const key = (event: KeyboardEvent) => {
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
  const current = shown[selected];
  const marked = current === undefined ? undefined : badge(current);
  return (
    <div class="overlay" onClick={() => { open.value = false; }}>
      <div class="palette" role="dialog" aria-modal="true" aria-label="Go to, or run" onClick={(event) => { event.stopPropagation(); }}>
        <div class="palette-input">
          <span class="prompt" aria-hidden="true">
            ❯
          </span>
          <input
            ref={input}
            value={query}
            placeholder="a command, a server, a page…"
            aria-label="Go to, or run"
            spellcheck={false}
            autoComplete="off"
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setSelected(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") setSelected(Math.min(selected + 1, shown.length - 1));
              else if (event.key === "ArrowUp") setSelected(Math.max(selected - 1, 0));
              else if (event.key === "Enter") {
                if (current !== undefined) choose(current);
              } else return;
              event.preventDefault();
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div class="palette-head">
          <span>{query.trim() === "" ? "everything" : "matches"}</span>
          <span class="rule" aria-hidden="true" />
          <span>{shown.length}</span>
        </div>
        <ul role="listbox" aria-label="Results">
          {shown.map((item, index) => {
            const mark = badge(item);
            return (
              <li
                key={item.label}
                role="option"
                aria-selected={index === selected}
                class={index === selected ? "selected" : undefined}
                onMouseEnter={() => { setSelected(index); }}
                onClick={() => { choose(item); }}
              >
                <span class="prompt" aria-hidden="true">
                  {item.icon}
                </span>
                <span class="label">{item.label}</span>
                <span class="hint">{item.hint}</span>
                <span class={mark.class}>{mark.text}</span>
              </li>
            );
          })}
          {shown.length === 0 ? <li class="empty">Nothing matches “{query}”: try a server's name or a verb.</li> : null}
        </ul>
        {current === undefined || marked === undefined ? null : (
          <div class="palette-preview" aria-live="polite">
            <div class="line">
              <span class="tone-muted" aria-hidden="true">
                $
              </span>
              <strong class="ellipsis">{current.line}</strong>
              <span class="spacer" />
              <span class={marked.class.replace("badge ", "")}>{marked.guard}</span>
            </div>
            <p>{current.hint}</p>
          </div>
        )}
        <div class="palette-foot">
          <span>
            <kbd>↑↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
          <span class="spacer" />
          <span>nothing changes before its plan is shown</span>
        </div>
      </div>
    </div>
  );
};

export const openPalette = () => {
  open.value = true;
};
