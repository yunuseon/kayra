import { useState } from "preact/hooks";
import type { ServerFacts } from "../../../cli/src/clients/wire/contract.gen.ts";
import { Notes } from "../components/notes.tsx";
import { openOperation } from "../components/operation.tsx";
import { OperationActions } from "../components/operations.tsx";
import { Link } from "../components/shell.tsx";
import { Dot, Header, Problem, Section, Tag, Waiting } from "../components/ui.tsx";
import { attention, newest, primary, strip, stripLabel } from "../overview.ts";
import { health, kayra, login, machine, ssh, verdict, type Cell, type Server } from "../reach.ts";
import { fleet, now, recorded, refreshStatus, status } from "../state.ts";
import { ago, startedAt } from "../time.ts";
import { Journal } from "./runs.tsx";

const day = 24 * 60 * 60 * 1000;

const CellView = ({ cell }: { readonly cell: Cell | undefined }) =>
  cell === undefined ? (
    <span class="tone-muted">—</span>
  ) : (
    <span class="cell" title={cell.title}>
      <Dot tone={cell.tone} />
      <span class={cell.tone === "waiting" ? "tone-muted" : `tone-${cell.tone}`}>{cell.text}</span>
    </span>
  );

const Row = ({ facts, seen }: { readonly facts: ServerFacts; readonly seen: Server | undefined }) => {
  const state = verdict(seen);
  const runs = recorded.value.state === "ready" ? recorded.value.value : [];
  const states = strip(runs, facts.name, 16);
  const last = newest(runs).find((run) => run.server === facts.name);
  const command = primary(facts);
  return (
    <div class="grow-row">
      <Tag word={state.word} tone={state.tone} />
      <div class="ellipsis">
        <Link to={{ page: "server", server: facts.name }}>
          <strong>{facts.name}</strong>
        </Link>
        <span class="second ellipsis">
          {facts.kind} · {facts.target} · {facts.domain}
        </span>
      </div>
      <CellView cell={seen === undefined ? undefined : machine(seen)} />
      <CellView cell={seen === undefined ? undefined : ssh(seen)} />
      <CellView cell={seen === undefined ? undefined : login(seen)} />
      <CellView cell={seen === undefined ? undefined : kayra(seen)} />
      <div>
        <span class="strip" role="img" aria-label={stripLabel(states)}>
          {states.map((each, index) => (
            <span key={index} class={each} />
          ))}
        </span>
        <span class="second">{last === undefined ? "no runs yet" : ago(now.value - startedAt(last.started))}</span>
      </div>
      <div class="row-actions">
        {facts.commands.includes("plan") ? (
          <button type="button" class="button small" onClick={() => { openOperation("plan", { server: facts.name }); }}>
            plan
          </button>
        ) : null}
        {command === undefined ? null : (
          <button type="button" class="button small primary" onClick={() => { openOperation(command, { server: facts.name }); }}>
            {command}
          </button>
        )}
      </div>
    </div>
  );
};

const Tiles = ({ servers, seen }: { readonly servers: readonly ServerFacts[]; readonly seen: readonly Server[] }) => {
  const find = (name: string) => seen.find((each) => each.name === name);
  const answering = servers.filter((server) => health(find(server.name)) === "ok");
  const asked = seen.filter((server) => server.kayra.state !== "skipped" && server.kayra.state !== "pending");
  const behind = asked.filter((server) => kayra(server).tone === "warn");
  const pin = seen[0]?.kayra.pin;
  const runs = recorded.value.state === "ready" ? recorded.value.value : [];
  const today = runs.filter((run) => now.value - startedAt(run.started) < day);
  const failed = today.filter((run) => run.state === "failed").length;
  const running = runs.filter((run) => run.state === "running").length;
  const apps = servers.flatMap((server) => server.apps);
  const platforms = servers.filter((server) => server.kind === "platform").length;
  const quiet = servers.filter((server) => health(find(server.name)) !== "ok").map((server) => server.name);
  return (
    <div class="tiles">
      <div class="tile">
        <div class="tile-label">
          <span>servers</span>
          <span class={status.value.live ? undefined : quiet.length === 0 ? "tone-ok" : "tone-warn"}>
            {status.value.live ? "asking" : quiet.length === 0 ? "all answer" : `${String(quiet.length)} not answering`}
          </span>
        </div>
        <div class="tile-value">
          {answering.length}
          <small>/{servers.length} answering</small>
        </div>
        <div class="tile-sub bar" aria-hidden="true">
          {servers.map((server) => (
            <span key={server.name} class={`tone-${verdict(find(server.name)).tone}`}>
              █
            </span>
          ))}
        </div>
      </div>
      <div class="tile">
        <div class="tile-label">
          <span>kayra</span>
          <span class={asked.length === 0 ? undefined : behind.length === 0 ? "tone-ok" : "tone-warn"}>
            {asked.length === 0 ? "not asked" : behind.length === 0 ? "on the pin" : `${String(behind.length)} behind`}
          </span>
        </div>
        <div class="tile-value">
          {asked.length - behind.length}
          <small>
            /{asked.length} on {pin ?? "the pin"}
          </small>
        </div>
        <div class="tile-sub ellipsis">{behind.length === 0 ? (asked.length === 0 ? "read over SSH; none open yet" : "every server asked runs it") : behind.map((server) => server.name).join(", ")}</div>
      </div>
      <div class="tile">
        <div class="tile-label">
          <span>runs · 24h</span>
          <span class={failed === 0 ? undefined : "tone-bad"}>{failed === 0 ? "none failed" : `${String(failed)} failed`}</span>
        </div>
        <div class="tile-value">{today.length}</div>
        <div class="tile-sub">{running === 0 ? "nothing running" : `${String(running)} running now`}</div>
      </div>
      <div class="tile">
        <div class="tile-label">
          <span>apps</span>
          <span>{platforms} platform</span>
        </div>
        <div class="tile-value">{apps.length}</div>
        <div class="tile-sub ellipsis">{apps.length === 0 ? "none in any server.yml" : apps.join(", ")}</div>
      </div>
    </div>
  );
};

export const FleetView = () => {
  const [query, setQuery] = useState("");
  const loaded = fleet.value;
  if (loaded.state === "loading") return <Waiting what="Reading the fleet" />;
  if (loaded.state === "failed") return <Problem failure={loaded.failure} />;
  const { value: seen, live } = status.value;
  const reached = seen?.servers ?? [];
  const { servers, version } = loaded.value;
  const wanted = query.trim().toLowerCase();
  const shown = servers.filter((server) => wanted === "" || [server.name, server.kind, server.target, server.domain].join(" ").includes(wanted));
  const runs = recorded.value.state === "ready" ? recorded.value.value : [];
  return (
    <>
      <Header kicker="fleet" title={loaded.value.fleet} sub={`${String(servers.length)} servers · kayra ${version} pinned · every command from this machine`}>
        <button type="button" class="button" onClick={refreshStatus} disabled={live}>
          {live ? "asking…" : "ask again"}
          <span class="aside">status</span>
        </button>
        <Link to={{ page: "validate" }} class="button">
          validate
          <span class="aside">read only</span>
        </Link>
      </Header>

      <Tiles servers={servers} seen={reached} />

      <Section
        title="servers"
        aside={
          <label class="filter">
            <span class="prompt" aria-hidden="true">/</span>
            <span class="visually-hidden">Filter servers</span>
            <input
              value={query}
              placeholder="filter"
              spellcheck={false}
              onInput={(event) => {
                setQuery(event.currentTarget.value);
              }}
            />
          </label>
        }
      >
        <div class="panel scroll-x servers-table">
          <div class="gtable">
            <div class="ghead">
              <span>state</span>
              <span>server</span>
              <span>address</span>
              <span>ssh</span>
              <span>login</span>
              <span>kayra</span>
              <span>last runs</span>
              <span class="right">actions</span>
            </div>
            {shown.map((server) => (
              <Row key={server.name} facts={server} seen={reached.find((each) => each.name === server.name)} />
            ))}
            {shown.length === 0 ? <p class="empty pad">No server matches “{query}”.</p> : null}
          </div>
        </div>
      </Section>

      <div class="split">
        <div class="wide">
          <Section title="journal" aside={<Link to={{ page: "runs" }} class="small">all runs →</Link>}>
            <Journal limit={8} />
          </Section>
        </div>
        <div class="side">
          <Section title="needs you">
            <Notes notes={attention(servers, reached, runs)} quiet={seen === undefined ? "Still asking every server." : "Every server answered; no run failed last."} />
          </Section>
        </div>
      </div>

      <Section title="fleet commands">
        <OperationActions />
      </Section>
    </>
  );
};
