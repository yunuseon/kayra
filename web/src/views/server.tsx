import type { CommandInput, ServerCommand, ServerFacts } from "../../../cli/src/web/contract.ts";
import { show } from "../components/preview.tsx";
import { Link } from "../components/shell.tsx";
import { Dot, Fact, Header, Pill, Waiting } from "../components/ui.tsx";
import { health, login, machine, ssh } from "../reach.ts";
import { fleet, status } from "../state.ts";
import { RunTable } from "./runs.tsx";

const what: Readonly<Record<ServerCommand, string>> = {
  deploy: "Host setup and every app, then verify",
  apps: "Register every app in server.yml, remove the rest",
  verify: "Check it as its users see it",
  setup: "The host layer: the playbook for its kind",
  plan: "What provision and setup would change, changing nothing",
  up: "Provision, set up, every app, /etc/hosts",
  provision: "Create or update the machine",
  "backup test": "Restore the latest backup to a scratch dir and check it",
  adopt: "Once, for a server kayra did not create",
  down: "Destroy the machine",
};

const danger: readonly ServerCommand[] = ["down", "adopt", "provision"];

const Actions = ({ facts }: { readonly facts: ServerFacts }) => {
  const commands = facts.commands.filter((name): name is ServerCommand => name !== "job");
  return (
    <div class="action-grid">
      {commands.map((name, index) => (
        <button
          key={name}
          class={`action${index === 0 ? " primary" : ""}${danger.includes(name) ? " danger" : ""}`}
          disabled={facts.needsTerminal && name !== "plan" && name !== "verify"}
          onClick={() => {
            show({ name, server: facts.name } satisfies CommandInput);
          }}
        >
          <strong>{name}</strong>
          <span>{what[name]}</span>
        </button>
      ))}
      {facts.commands.includes("job") ? (
        <>
          <button class="action" onClick={() => { show({ name: "job", server: facts.name, job: "gc", noPrs: false }); }}>
            <strong>job gc</strong>
            <span>The registry's garbage collection, now</span>
          </button>
          <button class="action" onClick={() => { show({ name: "job", server: facts.name, job: "renovate", noPrs: true }); }}>
            <strong>job renovate</strong>
            <span>Renovate now, logging what it would change</span>
          </button>
        </>
      ) : null}
    </div>
  );
};

export const ServerView = ({ name }: { readonly name: string }) => {
  const loaded = fleet.value;
  if (loaded.state !== "ready") return <Waiting what="Reading the fleet" />;
  const facts = loaded.value.servers.find((each) => each.name === name);
  if (facts === undefined) return <p class="empty">No server {name} in this fleet.</p>;
  const seen = status.value.value?.servers.find((each) => each.name === name);
  return (
    <>
      <Header
        title={
          <>
            <Dot tone={health(seen)} /> {facts.name}
          </>
        }
        sub={
          <>
            <Pill>{facts.kind}</Pill> <Pill>{facts.target}</Pill>{" "}
            <a href={`https://${facts.domain}`} target="_blank" rel="noreferrer">
              {facts.domain}
            </a>
          </>
        }
      />
      {facts.needsTerminal ? (
        <div class="notice">Its vault password is asked on a terminal: what opens its secrets runs from the command line, or give it a vault_password_file.</div>
      ) : null}
      <div class="columns">
        <section class="card">
          <h2>Now</h2>
          {seen === undefined ? (
            <Waiting what="asking" />
          ) : (
            <dl class="facts">
              <Fact label="Address" cell={machine(seen)} />
              <Fact label="SSH" cell={ssh(seen)} />
              <Fact label="Login" cell={login(seen)} />
            </dl>
          )}
        </section>
        <section class="card">
          <h2>Apps</h2>
          {facts.apps.length === 0 ? (
            <p class="empty">{facts.kind === "platform" ? "None in server.yml." : `A ${facts.kind} server runs no apps.`}</p>
          ) : (
            <ul class="links">
              {facts.apps.map((app) => (
                <li key={app}>
                  <Link to={{ page: "app", server: facts.name, app }}>{app}</Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <section class="card">
        <h2>Commands</h2>
        <Actions facts={facts} />
      </section>
      <section class="card">
        <h2>Runs from here</h2>
        <RunTable server={facts.name} />
      </section>
    </>
  );
};
