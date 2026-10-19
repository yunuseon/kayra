import { useEffect, useState } from "preact/hooks";
import type { AppReleases, AppRuns } from "../../../cli/src/clients/api/contract.gen.ts";
import { operation, type Answer } from "../api.ts";
import { show } from "../components/operation.tsx";
import { Dot, Header, Pill, Problem, Waiting } from "../components/ui.tsx";
import { ago, duration } from "../time.ts";
import { typed } from "../typed.ts";

type Tab = "runs" | "releases" | "log";

const useAnswer = <T,>(load: () => Promise<Answer<T>>, key: string) => {
  const [answer, setAnswer] = useState<Answer<T> | undefined>(undefined);
  const reload = () => {
    setAnswer(undefined);
    void load().then(setAnswer);
  };
  useEffect(reload, [key]);
  return typed<readonly [Answer<T> | undefined, () => void]>([answer, reload]);
};

const stateTone = (state: AppRuns["runs"][number]["state"]) => (state === "success" ? "ok" : state === "failure" ? "bad" : "waiting");

const Runs = ({ server, app, open }: { readonly server: string; readonly app: string; readonly open: (run: string) => void }) => {
  const [answer] = useAnswer(() => operation<AppRuns>("app.runs", {server, app}), `${server}/${app}`);
  if (answer === undefined) return <Waiting what="Asking the deployer" />;
  if (!answer.ok) return <Problem failure={answer.failure} />;
  const now = Date.now();
  const { live, runs } = answer.value;
  return (
    <>
      <p class="sub">{live === undefined ? "Not deployed yet." : `Live: ${live.sha.slice(0, 7)} since ${ago(now - Date.parse(live.time))}`}</p>
      <table class="table">
        <thead>
          <tr>
            <th />
            <th>Commit</th>
            <th>Why</th>
            <th>What</th>
            <th class="right">When</th>
            <th class="right">Took</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id} class="clickable" onClick={() => { open(run.id); }}>
              <td class="narrow">
                <Dot tone={stateTone(run.state)} label={run.state} />
              </td>
              <td>
                <code>{run.sha?.slice(0, 7) ?? ""}</code>
              </td>
              <td>{run.why}</td>
              <td>{run.what}</td>
              <td class="right tone-muted">{ago(now - Date.parse(run.started))}</td>
              <td class="right tone-muted">{run.finished === undefined ? "" : duration(Date.parse(run.finished) - Date.parse(run.started))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
};

const Releases = ({ server, app }: { readonly server: string; readonly app: string }) => {
  const [answer] = useAnswer(() => operation<AppReleases>("app.releases", {server, app}), `${server}/${app}`);
  if (answer === undefined) return <Waiting what="Asking the deployer" />;
  if (!answer.ok) return <Problem failure={answer.failure} />;
  const now = Date.now();
  return (
    <ul class="releases">
      {answer.value.releases.map((release) => (
        <li key={release.sha}>
          <code>{release.sha.slice(0, 12)}</code>
          <span class="tone-muted">{ago(now - Date.parse(release.time))}</span>
          {release.live ? (
            <Pill tone="ok">live</Pill>
          ) : (
            <button class="button small" onClick={() => { show({ name: "app.rollback", server, app, sha: release.sha }); }}>
              Roll back to it
            </button>
          )}
        </li>
      ))}
    </ul>
  );
};

/** A deployer's log, its errors and warnings marked as the terminal marks them. */
const mark = (line: string) => {
  if (/\b(error|failed|fatal|refused)\b/i.test(line)) return typed<string | undefined>("tone-bad");
  if (/\bwarn(ing)?\b/i.test(line)) return typed<string | undefined>("tone-warn");
  return undefined;
};

const Log = ({ server, app, run }: { readonly server: string; readonly app: string; readonly run: string | undefined }) => {
  const [answer] = useAnswer(() => operation<string>("app.log", {server, app, ...(run === undefined ? {} : {run})}), `${server}/${app}/${run ?? ""}`);
  if (answer === undefined) return <Waiting what="Fetching the log" />;
  if (!answer.ok) return <Problem failure={answer.failure} />;
  return (
    <pre class="log">
      {answer.value.split("\n").map((line, index) => (
        <div key={index} class={mark(line)}>
          {line === "" ? " " : line}
        </div>
      ))}
    </pre>
  );
};

export const AppView = ({ server, app }: { readonly server: string; readonly app: string }) => {
  const [tab, setTab] = useState<Tab>("runs");
  const [run, setRun] = useState<string | undefined>(undefined);
  const [ref, setRef] = useState("");
  return (
    <>
      <Header title={app} sub={`on ${server}`}>
        <form
          class="inline"
          onSubmit={(event) => {
            event.preventDefault();
            show({ name: "app.deploy", server, app, ...(ref.trim() === "" ? {} : { ref: ref.trim() }) });
          }}
        >
          <input value={ref} onInput={(event) => { setRef(event.currentTarget.value); }} placeholder="its ref" spellcheck={false} aria-label="Branch, tag or commit" />
          <button type="submit" class="button primary">
            Deploy
          </button>
        </form>
      </Header>
      <nav class="tabs" role="tablist">
        {(["runs", "releases", "log"] as const).map((each) => (
          <button key={each} role="tab" aria-selected={tab === each} class={tab === each ? "tab current" : "tab"} onClick={() => { setTab(each); }}>
            {each}
            {each === "log" && run !== undefined ? ` · ${run}` : ""}
          </button>
        ))}
      </nav>
      <section class="card">
        {tab === "runs" ? (
          <Runs
            server={server}
            app={app}
            open={(id) => {
              setRun(id);
              setTab("log");
            }}
          />
        ) : tab === "releases" ? (
          <Releases server={server} app={app} />
        ) : (
          <Log server={server} app={app} run={run} />
        )}
      </section>
      <p class="tone-muted small">
        Purging an app's data is irreversible:{" "}
        <button class="link danger-link" onClick={() => { show({ name: "app.purge", server, app }); }}>
          purge {app}'s volumes
        </button>
      </p>
    </>
  );
};
