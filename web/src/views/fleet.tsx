import type { ServerFacts } from "../../../cli/src/clients/wire/contract.gen.ts";
import { OperationActions } from "../components/operations.tsx";
import { Link } from "../components/shell.tsx";
import { Dot, Fact, Header, Pill, Problem, Waiting } from "../components/ui.tsx";
import { health, login, machine, ssh, type Server } from "../reach.ts";
import { fleet, refreshStatus, status } from "../state.ts";

const Card = ({ facts, seen }: { readonly facts: ServerFacts; readonly seen: Server | undefined }) => (
  <Link to={{ page: "server", server: facts.name }} class="card server-card">
    <div class="card-head">
      <Dot tone={health(seen)} />
      <h2>{facts.name}</h2>
      <Pill>{facts.kind}</Pill>
      <Pill tone={facts.target === "multipass" ? "muted" : facts.target === "hetzner" ? "accent" : "active"}>{facts.target}</Pill>
    </div>
    <div class="domain">{facts.domain}</div>
    {seen === undefined ? (
      <Waiting what="asking" />
    ) : (
      <dl class="facts">
        <Fact label="Address" cell={machine(seen)} />
        <Fact label="SSH" cell={ssh(seen)} />
        <Fact label="Login" cell={login(seen)} />
      </dl>
    )}
    {facts.apps.length === 0 ? null : (
      <div class="chips">
        {facts.apps.map((app) => (
          <Pill key={app}>{app}</Pill>
        ))}
      </div>
    )}
  </Link>
);

export const FleetView = () => {
  const loaded = fleet.value;
  if (loaded.state === "loading") return <Waiting what="Reading the fleet" />;
  if (loaded.state === "failed") return <Problem failure={loaded.failure} />;
  const { value: seen, live } = status.value;
  const { servers } = loaded.value;
  const up = servers.filter((server) => health(seen?.servers.find((each) => each.name === server.name)) === "ok").length;
  return (
    <>
      <Header
        title="Fleet"
        sub={
          <>
            {servers.length} servers · {seen === undefined ? "asking each" : `${String(up)} answering everything they were asked`}
          </>
        }
      >
        <button
          class="button"
          onClick={() => {
            refreshStatus();
          }}
          disabled={live}
        >
          {live ? "Asking…" : "Ask again"}
        </button>
      </Header>
      <div class="cards">
        {servers.map((server) => (
          <Card key={server.name} facts={server} seen={seen?.servers.find((each) => each.name === server.name)} />
        ))}
      </div>
      <section class="card">
        <h2>Fleet and local commands</h2>
        <OperationActions />
      </section>
    </>
  );
};
