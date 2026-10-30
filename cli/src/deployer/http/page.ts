import type { Owner, RunId } from "../brand.ts";
import type { RunMeta } from "../runs/records.ts";
import { log, meta, owners, runsOf } from "../runs/read.ts";

/** The read-only runs pages at deploy.<domain>, behind Authelia. */

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const shell = (title: string, content: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fafafa; --muted: #6e6e73; --line: #e0e0e0; --ok: #1a7f37; --bad: #cf222e; --run: #9a6700; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6e6e6; --bg: #161618; --muted: #9a9aa0; --line: #2c2c30; --ok: #3fb950; --bad: #f85149; --run: #d29922; } }
body { font: 15px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); margin: 0 auto; max-width: 72rem; padding: 1.5rem 1rem; }
h1 { font-size: 1.3rem; } h2 { font-size: 1.05rem; margin-top: 2rem; }
a { color: inherit; } table { border-collapse: collapse; width: 100%; }
td { padding: .3rem .6rem .3rem 0; border-bottom: 1px solid var(--line); vertical-align: top; }
.muted { color: var(--muted); } .success { color: var(--ok); } .failure { color: var(--bad); } .running { color: var(--run); } .queued, .superseded { color: var(--muted); }
code, pre { font: 13px/1.45 ui-monospace, monospace; } pre { white-space: pre-wrap; overflow-wrap: anywhere; }
</style></head><body>${content}</body></html>
`;

const row = (run: RunMeta) =>
  `<tr><td><a href="/runs/${escape(run.owner)}/${escape(run.id)}"><code>${escape(run.id)}</code></a></td>` +
  `<td class="${run.state}">${run.state}</td><td>${escape(run.what)}</td><td class="muted">${run.why}</td>` +
  `<td><code>${run.sha === undefined ? "" : run.sha.slice(0, 12)}</code></td></tr>`;

export const page = (runs: string) => {
  const sections = owners(runs).map(
    (who) => `<h2>${escape(who)}</h2><table>${runsOf(runs, who).slice(0, 10).map(row).join("")}</table>`,
  );
  return shell("Runs", `<h1>Runs</h1>${sections.length === 0 ? `<p class="muted">Nothing has run yet.</p>` : sections.join("")}`);
};

export const runPage = (runs: string, who: Owner, id: RunId) => {
  const found = meta(runs, who, id);
  if (found === undefined) return shell("Not found", `<p><a href="/">Runs</a> · no run ${escape(id)}</p>`);
  return shell(
    `${who} ${id}`,
    `<p><a href="/">Runs</a> · ${escape(who)}</p><h1 class="${found.state}">${escape(found.what)} — ${found.state}</h1>` +
      `<p class="muted">${found.why}, started ${escape(found.started)}${found.finished === undefined ? "" : `, finished ${escape(found.finished)}`}</p>` +
      (found.error === undefined ? "" : `<p class="failure">${escape(found.error)}</p>`) +
      (found.urls === undefined ? "" : `<p>${found.urls.map((url) => `<a href="${escape(url)}">${escape(url)}</a>`).join(" · ")}</p>`) +
      `<pre>${escape(log(runs, who, id) ?? "")}</pre>`,
  );
};
