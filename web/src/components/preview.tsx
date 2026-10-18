import type { CommandInput } from "../commands.ts";
import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Listed, Preview } from "../../../cli/src/clients/api/contract.gen.ts";
import { preview, startRun, type Answer, type Failure } from "../api.ts";
import { fleet, go } from "../state.ts";
import { Pill, Problem, Waiting } from "./ui.tsx";

/** The command whose plan is shown, if one: every command is seen before it runs. */
export const previewing = signal<CommandInput | undefined>(undefined);

export const show = (command: CommandInput): void => {
  previewing.value = command;
};

const close = (): void => {
  previewing.value = undefined;
};

const kindTone = (kind: string) => (kind === "guard" ? "warn" : kind === "confirm" ? "bad" : kind === "note" ? "muted" : "active");

const Step = ({ step }: { readonly step: Listed }) => (
  <li class="plan-step">
    <span class="plan-index">{step.index + 1}</span>
    <div>
      <div class="plan-title">
        <Pill tone={kindTone(step.kind)}>{step.kind}</Pill> {step.title}
      </div>
      {step.command === undefined ? null : <code class="plan-command">{step.command}</code>}
    </div>
  </li>
);

/** A real server: anything but a multipass test VM, so a change asks for its name, as `kayra down` does on the terminal. */
const realServer = (command: CommandInput): string | undefined => {
  if (!("server" in command)) return undefined;
  const loaded = fleet.value;
  const facts = loaded.state === "ready" ? loaded.value.servers.find((each) => each.name === command.server) : undefined;
  return facts === undefined || facts.target === "multipass" ? undefined : facts.name;
};

const Body = ({ command }: { readonly command: CommandInput }) => {
  const [shown, setShown] = useState<Answer<Preview> | undefined>(undefined);
  const [typed, setTyped] = useState("");
  const [starting, setStarting] = useState<Failure | "starting" | undefined>(undefined);
  const confirmInput = useRef<HTMLInputElement>(null);
  const ready = shown?.ok === true;
  useEffect(() => {
    if (ready) confirmInput.current?.focus();
  }, [ready]);
  useEffect(() => {
    void preview(command).then(setShown);
  }, [command]);
  if (shown === undefined) return <Waiting what="Planning" />;
  if (!shown.ok) return <Problem failure={shown.failure} />;
  const { invocation, steps, changes } = shown.value;
  const real = changes ? realServer(command) : undefined;
  const confirmed = real === undefined || typed === real;
  const run = async (): Promise<void> => {
    setStarting("starting");
    const started = await startRun(command, real === undefined ? undefined : typed);
    if (started.ok) {
      close();
      go({ page: "run", id: started.value.id });
    } else setStarting(started.failure);
  };
  const parts = steps.reduce<readonly { readonly part: string | undefined; readonly steps: readonly Listed[] }[]>((groups, step) => {
    const last = groups.at(-1);
    return step.opens !== undefined || last === undefined
      ? [...groups, { part: step.opens, steps: [step] }]
      : [...groups.slice(0, -1), { ...last, steps: [...last.steps, step] }];
  }, []);
  return (
    <>
      <div class="sheet-head">
        <code class="command">{invocation.command}</code>
        <div class="sub">
          {invocation.about.join(" · ")} · {steps.length} steps · {changes ? "changes things" : "reads only"}
        </div>
      </div>
      <div class="sheet-body">
        {parts.map((group, index) => (
          <section key={index}>
            {group.part === undefined ? null : <h3 class="part">{group.part}</h3>}
            <ol class="plan">
              {group.steps.map((step) => (
                <Step key={step.index} step={step} />
              ))}
            </ol>
          </section>
        ))}
      </div>
      <form
        class="sheet-foot"
        onSubmit={(event) => {
          event.preventDefault();
          if (confirmed) void run();
        }}
      >
        {real === undefined ? null : (
          <label class="confirm">
            <span>
              This changes <strong>{real}</strong>, a real server. Type its name to go on:
            </span>
            <input ref={confirmInput} value={typed} onInput={(event) => { setTyped(event.currentTarget.value); }} placeholder={real} spellcheck={false} />
          </label>
        )}
        {starting === undefined || starting === "starting" ? null : <Problem failure={starting} />}
        <div class="buttons">
          <button type="button" class="button" onClick={close}>
            Cancel
          </button>
          <button type="submit" class={real === undefined ? "button primary" : "button danger"} disabled={!confirmed || starting === "starting"}>
            {starting === "starting" ? "Starting…" : `Run ${invocation.command}`}
          </button>
        </div>
      </form>
    </>
  );
};

/** The plan of the command about to run, as --dry-run shows it, and the button that runs it. */
export const PreviewSheet = () => {
  const command = previewing.value;
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    addEventListener("keydown", escape);
    return () => {
      removeEventListener("keydown", escape);
    };
  }, []);
  if (command === undefined) return null;
  return (
    <div class="overlay" onClick={close}>
      <div class="sheet" role="dialog" aria-modal="true" onClick={(event) => { event.stopPropagation(); }}>
        <Body command={command} />
      </div>
    </div>
  );
};
