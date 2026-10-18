import { useEffect } from "preact/hooks";
import type { Validation } from "../../../cli/src/clients/api/contract.ts";
import { Dot, Header, Pill, Problem, Waiting } from "../components/ui.tsx";
import { loadValidation, validation } from "../state.ts";

type Verdict = Validation["result"];

const tone = (verdict: Verdict) => (verdict === "problem" ? "bad" : verdict === "unchecked" ? "warn" : "ok");
const glyph = (verdict: Verdict) => (verdict === "problem" ? "✗" : verdict === "unchecked" ? "·" : "✓");
const words: Readonly<Record<Verdict, string>> = { problem: "problems", unchecked: "partly checked", passed: "holds" };

export const ValidateView = () => {
  useEffect(() => {
    void loadValidation();
  }, []);
  const loaded = validation.value;
  if (loaded.state === "loading") return <Waiting what="Checking the fleet beyond its schemas" />;
  if (loaded.state === "failed") return <Problem failure={loaded.failure} />;
  const { result, servers } = loaded.value;
  const count = (verdict: Verdict) => servers.flatMap((server) => server.findings).filter((finding) => finding.result === verdict).length;
  return (
    <>
      <Header
        title="Validate"
        sub={`Secrets, apps against their contract, stacks, routes · ${String(count("problem"))} problems · ${String(count("unchecked"))} not checked`}
      >
        <Pill tone={tone(result)}>{words[result]}</Pill>
        <button class="button" onClick={() => void loadValidation()}>
          Check again
        </button>
      </Header>
      {servers.map((server) => (
        <section key={server.name} class="card">
          <div class="card-head">
            <Dot tone={tone(server.result)} />
            <h2>{server.name}</h2>
            <Pill>{server.kind}</Pill>
            <Pill>{server.target}</Pill>
            <span class="grow" />
            <Pill tone={tone(server.result)}>{words[server.result]}</Pill>
          </div>
          <ul class="findings">
            {server.findings.map((finding, index) => (
              <li key={index} class={`finding finding-${finding.result}`}>
                <span class={`glyph tone-${tone(finding.result)}`}>{glyph(finding.result)}</span>
                <span>
                  {finding.text}
                  {finding.hint === null ? null : <span class="hint">→ {finding.hint}</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
};
