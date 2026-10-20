import type { RunState } from "../../../cli/src/clients/wire/contract.gen.ts";
import { Link } from "../components/shell.tsx";
import { Dot, Header, Problem, Waiting } from "../components/ui.tsx";
import { newest } from "../overview.ts";
import { now, recorded } from "../state.ts";
import { ago, clock, startedAt } from "../time.ts";

export const runTone: Readonly<Record<RunState, "waiting" | "ok" | "bad" | "warn">> = {
  running: "waiting",
  passed: "ok",
  failed: "bad",
  interrupted: "warn",
  declined: "warn",
};

/** Runs as a journal, the newest first; `server` narrows it to one, `limit` to the latest few. */
export const Journal = ({ server, limit }: { readonly server?: string; readonly limit?: number }) => {
  const loaded = recorded.value;
  if (loaded.state === "loading") return <Waiting what="Reading the runs" />;
  if (loaded.state === "failed") return <Problem failure={loaded.failure} />;
  const shown = newest(loaded.value)
    .filter((run) => server === undefined || run.server === server)
    .slice(0, limit ?? Number.POSITIVE_INFINITY);
  if (shown.length === 0) return <p class="empty panel pad">Nothing run from here yet.</p>;
  const at = now.value;
  return (
    <div class="panel scroll-x">
      <div class="journal">
        {shown.map((run) => (
          <Link key={run.id} to={{ page: run.session ? "session" : "run", id: run.id }} class="jrow">
            <span class="when">{clock(run.started, at)}</span>
            <Dot tone={runTone[run.state]} label={run.state} />
            <span class="ellipsis">{run.command}</span>
            <span class={`state tone-${runTone[run.state] === "waiting" ? "active" : runTone[run.state]}`}>{run.state}</span>
            <span class="ago">{ago(at - startedAt(run.started))}</span>
          </Link>
        ))}
      </div>
    </div>
  );
};

export const RunsView = () => (
  <>
    <Header kicker="journal" title="runs" sub="Every command run from here, recorded in the fleet's .cache/ui/runs." />
    <Journal />
  </>
);
