import { useEffect, useState } from "preact/hooks";
import type { RunState, RunSummary } from "../../../cli/src/clients/api/contract.gen.ts";
import { runs, type Answer } from "../api.ts";
import { Link } from "../components/shell.tsx";
import { Dot, Header, Problem, Waiting } from "../components/ui.tsx";
import { ago, startedAt } from "../time.ts";

const tone: Readonly<Record<RunState, "waiting" | "ok" | "bad" | "warn">> = {
  running: "waiting",
  passed: "ok",
  failed: "bad",
  interrupted: "warn",
  declined: "warn",
};

/** Runs as a table, the newest first; `server` narrows it to one. */
export const RunTable = ({ server }: { readonly server?: string }) => {
  const [answer, setAnswer] = useState<Answer<readonly RunSummary[]> | undefined>(undefined);
  useEffect(() => {
    const load = () => {
      void runs().then(setAnswer);
    };
    load();
    const timer = setInterval(load, 3_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  if (answer === undefined) return <Waiting what="Reading the runs" />;
  if (!answer.ok) return <Problem failure={answer.failure} />;
  const shown = answer.value.filter((run) => server === undefined || run.server === server);
  if (shown.length === 0) return <p class="empty">Nothing run from here yet.</p>;
  const now = Date.now();
  return (
    <table class="table">
      <tbody>
        {shown.map((run) => (
          <tr key={run.id}>
            <td class="narrow">
              <Dot tone={tone[run.state]} label={run.state} />
            </td>
            <td>
              <Link to={{ page: run.session ? "session" : "run", id: run.id }}>
                <code>{run.command}</code>
              </Link>
            </td>
            <td class={`tone-${tone[run.state] === "waiting" ? "active" : tone[run.state]}`}>{run.state}</td>
            <td class="tone-muted right">{ago(now - startedAt(run.started))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

export const RunsView = () => (
  <>
    <Header title="Runs" sub="Every command run from here, recorded in the fleet's .cache/ui/runs" />
    <section class="card">
      <RunTable />
    </section>
  </>
);
