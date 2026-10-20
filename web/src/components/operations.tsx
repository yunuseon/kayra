import type { ServerFacts } from "../../../cli/src/clients/wire/contract.gen.ts";
import { onServer, reaches } from "../operations.ts";
import { catalog } from "../state.ts";
import { openOperation } from "./operation.tsx";
import { Effect, Problem, Waiting } from "./ui.tsx";

export const OperationActions = ({ server }: { readonly server?: ServerFacts }) => {
  const loaded = catalog.value;
  if (loaded.state === "loading") return <Waiting what="Reading operations" />;
  if (loaded.state === "failed") return <Problem failure={loaded.failure} />;
  const operations =
    server === undefined
      ? loaded.value.filter((operation) => operation.scope === "fleet" || operation.scope === "repo")
      : onServer(loaded.value, server);
  return (
    <div class="action-grid">
      {operations.map((operation) => (
        <button
          key={operation.name}
          type="button"
          class={`action${operation.effect === "destroys" ? " danger" : ""}`}
          onClick={() => {
            openOperation(operation.name, server === undefined ? {} : { server: server.name });
          }}
        >
          <span class="icon" aria-hidden="true">
            {reaches[operation.name].icon}
          </span>
          <strong>{reaches[operation.name].label}</strong>
          <Effect effect={operation.effect} />
          <span class="about">{operation.summary}</span>
        </button>
      ))}
    </div>
  );
};
