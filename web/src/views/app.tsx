import { useEffect, useState } from "preact/hooks";
import type { AppReleases, AppRuns, DeploymentHealth, DeploymentStatus } from "../../../cli/src/clients/wire/contract.gen.ts";
import { operation, type Answer } from "../api.ts";
import { openOperation, show } from "../components/operation.tsx";
import { Dot, Header, Pill, Problem, Waiting } from "../components/ui.tsx";
import { ago, duration } from "../time.ts";
import { deploymentView } from "../deployment.ts";
import { typed } from "../typed.ts";

type Tab = "runs" | "releases" | "log" | "deployment";

const useAnswer = <T,>(load: () => Promise<Answer<T>>, key: string) => {
  const [answer, setAnswer] = useState<Answer<T> | undefined>(undefined);
  const [revision, setRevision] = useState(0);
  const reload = () => { setRevision((value) => value + 1); };
  useEffect(() => {
    const stop = new AbortController();
    setAnswer(undefined);
    void load().then((value) => { if (!stop.signal.aborted) setAnswer(value); });
    return () => { stop.abort(); };
  }, [key, revision]);
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

const Release = ({ commit }: { readonly commit: string | null }) => commit === null ? <>None recorded</> : <code title={commit}>{commit.slice(0, 12)}</code>;

const Deployment = ({ server, app }: { readonly server: string; readonly app: string }) => {
  const [answer, refresh] = useAnswer(() => operation<DeploymentStatus>("app.deployment.status", { server, app }), `${server}/${app}/deployment`);
  const [health, refreshHealth] = useAnswer(() => operation<DeploymentHealth>("app.deployment.health", { server, app }), `${server}/${app}/health`);
  if (answer === undefined) return <Waiting what="Reading deployment state" />;
  if (!answer.ok) return <Problem failure={answer.failure} />;
  const state = answer.value;
  const preparation = state.preparation;
  const view = deploymentView(state, health?.ok === true ? health.value : undefined);
  const cancelRequest = view.cancelRequest;
  const resolution = preparation?.step === null || preparation?.step === undefined ? null : { run: preparation.request, step: preparation.step };
  return <>
    <div class="actions"><button class="button small" onClick={() => { refresh(); refreshHealth(); }}>Refresh deployment</button></div>
    <dl class="facts deployment-facts">
      <div class="fact"><dt>Runtime</dt><dd>{state.runtime}{state.runtime === "swarm" ? <> <Pill tone="warn">experimental</Pill></> : null}</dd></div>
      <div class="fact"><dt>Lifecycle</dt><dd>{state.lifecycle}</dd></div>
      <div class="fact"><dt>Rollout phase</dt><dd><Pill tone={view.phaseTone}>{view.phase}</Pill></dd></div>
      <div class="fact"><dt>Certified active release</dt><dd><Release commit={view.active} /></dd></div>
      <div class="fact"><dt>Last known good</dt><dd><Release commit={view.lastKnownGood} /></dd></div>
      <div class="fact"><dt>Requested release</dt><dd><Release commit={view.requested} /></dd></div>
      <div class="fact"><dt>Desired release</dt><dd><Release commit={view.desired} /></dd></div>
      <div class="fact"><dt>Recovery outcome</dt><dd>{view.recovery}</dd></div>
      <div class="fact"><dt>Required action</dt><dd class={state.requiredAction === "none" ? "" : "tone-bad"}>{view.action}</dd></div>
      <div class="fact"><dt>Current service health</dt><dd><Pill tone={view.runtimeTone}>{view.runtime}</Pill></dd></div>
      {view.observedAt === null ? null : <div class="fact"><dt>Observed at</dt><dd>{new Date(view.observedAt).toISOString()}</dd></div>}
    </dl>
    {state.verification === "legacy-unverified" ? <p class="tone-muted">Legacy Compose history has no certified active release.</p> : null}
    {state.verifiedActive === null ? null : <p class="tone-muted small">Release certified at {new Date(state.verifiedActive.verifiedAt).toISOString()}. Current service health is observed separately.</p>}
    {health === undefined ? <Waiting what="Observing current services" /> : !health.ok ? <Problem failure={health.failure} /> : null}
    {view.services.length === 0 ? null : <table class="table"><thead><tr><th>Service</th><th>State</th><th>Healthy / current</th><th>Historical tasks ignored</th></tr></thead><tbody>
      {view.services.map((service) => <tr key={service.name}><td>{service.name}</td><td>{service.state}</td><td>{service.healthyTasks ?? "unknown"} / {service.currentTasks ?? "unknown"}</td><td>{service.ignoredHistoricalTasks ?? "unknown"}</td></tr>)}
    </tbody></table>}
    {cancelRequest === null ? null : <button class="button" onClick={() => { show({ name: "app.deployment.cancel", server, app, request: cancelRequest }); }}>Cancel this rollout</button>}
    {resolution === null || state.requiredAction !== "inspect-and-resolve" ? null : <button class="button" onClick={() => { openOperation("app.migration.resolve", { server, app, run: resolution.run, step: resolution.step }); }}>Record migration recovery decision</button>}
  </>;
};

export const AppView = ({ server, app }: { readonly server: string; readonly app: string }) => {
  const [tab, setTab] = useState<Tab>("runs");
  const [run, setRun] = useState<string | undefined>(undefined);
  const [ref, setRef] = useState("");
  return (
    <>
      <Header kicker="app" title={app} sub={`on ${server}`}>
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
        {(["runs", "releases", "deployment", "log"] as const).map((each) => (
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
        ) : tab === "deployment" ? (
          <Deployment key={`${server}/${app}`} server={server} app={app} />
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
