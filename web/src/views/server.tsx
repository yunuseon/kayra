import { Notes } from "../components/notes.tsx";
import { openOperation } from "../components/operation.tsx";
import { OperationActions } from "../components/operations.tsx";
import { Link } from "../components/shell.tsx";
import { Fact, Header, Section, Tag, Waiting } from "../components/ui.tsx";
import { attention, primary } from "../overview.ts";
import { kayra, login, machine, ssh, verdict } from "../reach.ts";
import { fleet, recorded, refreshStatus, status } from "../state.ts";
import { Journal } from "./runs.tsx";

export const ServerView = ({ name }: { readonly name: string }) => {
  const loaded = fleet.value;
  if (loaded.state !== "ready") return <Waiting what="Reading the fleet" />;
  const facts = loaded.value.servers.find((each) => each.name === name);
  if (facts === undefined) return <p class="empty">No server {name} in this fleet.</p>;
  const { value, live } = status.value;
  const seen = value?.servers.find((each) => each.name === name);
  const state = verdict(seen);
  const command = primary(facts);
  const runs = recorded.value.state === "ready" ? recorded.value.value.filter((run) => run.server === name) : [];
  const notes = attention([facts], seen === undefined ? [] : [seen], runs).map((note) => ({
    ...note,
    remedies: note.remedies.filter((remedy) => !(remedy.kind === "go" && remedy.to.page === "server")),
  }));
  const run = (operation: "plan" | "verify" | "ssh" | "deploy" | "setup") => () => {
    openOperation(operation, { server: facts.name });
  };
  return (
    <>
      <Header
        kicker="server"
        title={facts.name}
        tag={<Tag word={state.word} tone={state.tone} />}
        sub={
          <>
            <span>
              kind <span class="tone-strong">{facts.kind}</span>
            </span>
            <span>
              target <span class="tone-strong">{facts.target}</span>
            </span>
            <span>
              domain{" "}
              <a href={`https://${facts.domain}`} target="_blank" rel="noreferrer" class="tone-strong">
                {facts.domain}
              </a>
            </span>
          </>
        }
      >
        <button type="button" class="button" onClick={run("ssh")}>
          ssh
          {seen?.ssh.state === "refused" ? <span class="aside">off</span> : null}
        </button>
        {facts.commands.includes("verify") ? (
          <button type="button" class="button" onClick={run("verify")}>
            verify<span class="aside">read only</span>
          </button>
        ) : null}
        {facts.commands.includes("plan") ? (
          <button type="button" class="button" onClick={run("plan")}>
            plan<span class="aside">dry run</span>
          </button>
        ) : null}
        {command === undefined ? null : (
          <button type="button" class="button primary" onClick={run(command)}>
            {command} {facts.name}
          </button>
        )}
      </Header>

      {notes.length === 0 ? null : <Notes notes={notes} quiet="" />}

      <div class="split">
        <div class="wide">
          {facts.kind === "platform" ? (
            <Section title="apps" meta={facts.apps.length}>
              {facts.apps.length === 0 ? (
                <p class="empty panel pad">None in server.yml.</p>
              ) : (
                <ul class="links panel">
                  {facts.apps.map((app) => (
                    <li key={app}>
                      <Link to={{ page: "app", server: facts.name, app }}>
                        <span class="prompt" aria-hidden="true">▸</span>
                        <span>{app}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          ) : null}
          <Section title="runs from here">
            <Journal server={facts.name} />
          </Section>
          <Section title="commands">
            <OperationActions server={facts} />
          </Section>
        </div>
        <div class="side">
          <Section
            title="reach"
            aside={
              <button type="button" class="button small" onClick={refreshStatus} disabled={live}>
                {live ? "asking…" : "ask again"}
              </button>
            }
          >
            <div class="panel pad">
              {seen === undefined ? (
                <Waiting what="asking" />
              ) : (
                <dl class="facts">
                  <Fact label="address" cell={machine(seen)} />
                  <Fact label="ssh" cell={ssh(seen)} />
                  <Fact label="login" cell={login(seen)} />
                  <Fact label="kayra" cell={kayra(seen)} />
                </dl>
              )}
            </div>
          </Section>
        </div>
      </div>
    </>
  );
};
