import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Listed, OperationInfo, OperationName, Preview, RunOptions } from "../../../cli/src/clients/api/contract.gen.ts";
import { operation, preview, start, stream, type Answer, type Failure } from "../api.ts";
import type { CommandInput } from "../commands.ts";
import { defaults, fields, inputOf, reaches, type Draft, type Field, type Values } from "../operations.ts";
import { catalog, fleet, go } from "../state.ts";
import { DirectoryPicker } from "./directory.tsx";
import { Pill, Problem, Waiting } from "./ui.tsx";

const selection = signal<Draft | undefined>(undefined);
export const openOperation = (name: OperationName, input: Readonly<Record<string, unknown>> = {}) => {
  selection.value = { name, input };
};
export const show = (command: CommandInput) => {
  openOperation(command.name, Object.fromEntries(Object.entries(command).filter(([key]) => key !== "name")));
};
const close = () => {
  selection.value = undefined;
};

const Step = ({ step }: { readonly step: Listed }) => (
  <li class="plan-step">
    <span class="plan-index">{step.index + 1}</span>
    <div>
      <div class="plan-title">
        <Pill tone={step.kind === "guard" ? "warn" : step.kind === "confirm" ? "bad" : "active"}>{step.kind}</Pill> {step.title}
      </div>
      {step.command === undefined ? null : <code class="plan-command">{step.command}</code>}
    </div>
  </li>
);

const FieldInput = ({
  field,
  value,
  change,
  server,
}: {
  readonly field: Field;
  readonly value: string | boolean;
  readonly change: (value: string | boolean) => void;
  readonly server: string | boolean | undefined;
}) => {
  const [browsing, setBrowsing] = useState(false);
  const loaded = fleet.value;
  const servers = loaded.state === "ready" ? loaded.value.servers : [];
  const text = typeof value === "string" ? value : "";
  const id = `operation-${field.name}`;
  if (field.type === "boolean")
    return (
      <label class="toggle">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => {
            change(event.currentTarget.checked);
          }}
        />
        {field.description || field.name}
      </label>
    );
  return (
    <div class="operation-field">
      <label for={id}>
        {field.name}
        {field.required ? "" : " (optional)"}
      </label>
      {field.name === "server" || field.choices.length > 0 ? (
        <select
          id={id}
          required={field.required}
          value={text}
          onChange={(event) => {
            change(event.currentTarget.value);
          }}
        >
          <option value="">{field.required ? "Choose…" : "All servers"}</option>
          {(field.name === "server" ? servers.map((each) => each.name) : field.choices).map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      ) : field.type === "array" ? (
        <textarea
          id={id}
          rows={3}
          value={text}
          required={field.required}
          placeholder="One item per line"
          onInput={(event) => {
            change(event.currentTarget.value);
          }}
        />
      ) : (
        <div class="inline">
          <input
            id={id}
            value={text}
            required={field.required}
            minLength={field.minLength}
            pattern={field.pattern}
            list={field.name === "app" ? "operation-apps" : undefined}
            spellcheck={false}
            onInput={(event) => {
              change(event.currentTarget.value);
            }}
          />
          {field.name === "dir" ? (
            <button
              type="button"
              class="button"
              onClick={() => {
                setBrowsing(!browsing);
              }}
            >
              Browse…
            </button>
          ) : null}
        </div>
      )}
      {field.name === "app" ? (
        <datalist id="operation-apps">
          {servers
            .find((each) => each.name === server)
            ?.apps.map((app) => (
              <option key={app} value={app} />
            ))}
        </datalist>
      ) : null}
      {field.description === "" ? null : <span class="hint">{field.description}</span>}
      {field.type === "array" ? (
        <span class="hint">One {field.name === "command" ? "argument" : "item"} per line. Spaces within a line are preserved.</span>
      ) : null}
      {browsing ? (
        <DirectoryPicker
          initial={text}
          close={() => {
            setBrowsing(false);
          }}
          choose={(path) => {
            change(path);
            setBrowsing(false);
          }}
        />
      ) : null}
    </div>
  );
};

type Prepared = { readonly draft: Draft; readonly options: RunOptions };
const OperationForm = ({
  info,
  seed,
  options,
  submit,
}: {
  readonly info: OperationInfo;
  readonly seed: Draft;
  readonly options: RunOptions;
  readonly submit: (value: Prepared) => void;
}) => {
  const [values, setValues] = useState<Values>(() => defaults(info.input, seed.input));
  const [verbose, setVerbose] = useState(options.verbose ?? false);
  const [dryRun, setDryRun] = useState(options.dryRun ?? false);
  const planned = info.kind === "plan" || info.kind === "session";
  const inputs = fields(info.input);
  const unsupported = inputs.some((field) => !field.supported);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit({ draft: { name: info.name, input: inputOf(info.input, values) }, options: { verbose, dryRun } });
      }}
    >
      <div class="sheet-body operation-fields">
        {inputs.map((field) => (
          <FieldInput
            key={field.name}
            field={field}
            value={values[field.name] ?? ""}
            server={values["server"]}
            change={(value) => {
              setValues({ ...values, [field.name]: value });
            }}
          />
        ))}
        {unsupported ? <p role="alert">This operation has an unsupported input. Update the UI before running it.</p> : null}
        {planned ? (
          <fieldset class="run-options">
            <legend>Run options</legend>
            <label class="toggle">
              <input
                type="checkbox"
                checked={verbose}
                onChange={(event) => {
                  setVerbose(event.currentTarget.checked);
                }}
              />
              Verbose output
            </label>
            <label class="toggle">
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(event) => {
                  setDryRun(event.currentTarget.checked);
                }}
              />
              Dry run — preview only
            </label>
          </fieldset>
        ) : null}
      </div>
      <div class="sheet-foot buttons">
        <button type="button" class="button" onClick={close}>
          Cancel
        </button>
        <button type="submit" class="button primary" disabled={unsupported}>
          {planned ? "Preview plan" : "Run query"}
        </button>
      </div>
    </form>
  );
};

const realServer = (draft: Draft) => {
  const loaded = fleet.value;
  const facts = loaded.state === "ready" ? loaded.value.servers.find((each) => each.name === draft.input["server"]) : undefined;
  return facts?.target === "multipass" ? undefined : facts?.name;
};

const Review = ({ prepared, back }: { readonly prepared: Prepared; readonly back: () => void }) => {
  const { draft, options } = prepared;
  const [shown, setShown] = useState<Answer<Preview> | undefined>(undefined);
  const [typed, setTyped] = useState("");
  const [starting, setStarting] = useState<Failure | "starting" | undefined>(undefined);
  useEffect(() => {
    void preview(draft, options).then(setShown);
  }, [prepared]);
  if (shown === undefined)
    return (
      <div class="sheet-body">
        <Waiting what="Planning" />
      </div>
    );
  if (!shown.ok)
    return (
      <div class="sheet-body">
        <Problem failure={shown.failure} />
        <button class="button" onClick={back}>
          Edit inputs
        </button>
      </div>
    );
  const { invocation, steps, changes } = shown.value;
  const real = changes && !options.dryRun ? realServer(draft) : undefined;
  const confirmed = real === undefined || typed === real;
  const run = async () => {
    setStarting("starting");
    const started = await start(draft, options, real === undefined ? undefined : typed);
    if (started.ok) {
      close();
      go("session" in started.value ? { page: "session", id: started.value.session } : { page: "run", id: started.value.run });
    } else setStarting(started.failure);
  };
  return (
    <>
      <div class="sheet-body">
        <code class="command">{invocation.command}</code>
        <p class="sub">
          {steps.length} steps · {changes ? "changes things" : "reads only"}
          {options.verbose ? " · verbose" : ""}
          {options.dryRun ? " · preview only" : ""}
        </p>
        <ol class="plan">
          {steps.map((step) => (
            <Step key={step.index} step={step} />
          ))}
        </ol>
      </div>
      <form
        class="sheet-foot"
        onSubmit={(event) => {
          event.preventDefault();
          if (confirmed && !options.dryRun) void run();
        }}
      >
        {real === undefined ? null : (
          <label class="confirm">
            <span>
              This changes <strong>{real}</strong>, a real server. Type its name to go on:
            </span>
            <input
              value={typed}
              onInput={(event) => {
                setTyped(event.currentTarget.value);
              }}
              placeholder={real}
              autoComplete="off"
              spellcheck={false}
            />
          </label>
        )}
        {starting === undefined || starting === "starting" ? null : <Problem failure={starting} />}
        <div class="buttons">
          <button type="button" class="button" onClick={back} disabled={starting === "starting"}>
            Edit inputs
          </button>
          {options.dryRun ? (
            <button type="button" class="button primary" onClick={close}>
              Done
            </button>
          ) : (
            <button
              type="submit"
              class={real === undefined ? "button primary" : "button danger"}
              disabled={!confirmed || starting === "starting"}
            >
              {starting === "starting" ? "Starting…" : draft.name === "ssh" ? "Open terminal" : "Run"}
            </button>
          )}
        </div>
      </form>
    </>
  );
};

const Query = ({ prepared, info, back }: { readonly prepared: Prepared; readonly info: OperationInfo; readonly back: () => void }) => {
  const [result, setResult] = useState<Answer<unknown> | undefined>(undefined);
  const [live, setLive] = useState(info.kind === "stream");
  useEffect(() => {
    const active = { current: true };
    if (info.kind === "stream")
      return stream<unknown>(
        `/api/operations/${info.name}`,
        (value) => {
          setResult({ ok: true, value });
        },
        () => {
          setLive(false);
        },
        { input: prepared.draft.input },
        (failure) => {
          setResult({ ok: false, failure });
        },
      );
    void operation<unknown>(info.name, prepared.draft.input).then((value) => {
      if (active.current) setResult(value);
    });
    return () => {
      active.current = false;
    };
  }, [prepared]);
  return (
    <>
      <div class="sheet-body">
        {result === undefined ? (
          <Waiting what="Asking kayra" />
        ) : !result.ok ? (
          <Problem failure={result.failure} />
        ) : (
          <pre class="query-result">{typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2)}</pre>
        )}
        {live ? <Waiting what="Receiving updates" /> : null}
      </div>
      <div class="sheet-foot buttons">
        <button class="button" onClick={back}>
          Edit inputs
        </button>
        <button class="button" onClick={close}>
          Close
        </button>
      </div>
    </>
  );
};

const Body = ({ draft, info }: { readonly draft: Draft; readonly info: OperationInfo }) => {
  const [prepared, setPrepared] = useState<Prepared | undefined>(undefined);
  const [seed, setSeed] = useState<Prepared>({ draft, options: {} });
  const back = () => {
    if (prepared !== undefined) setSeed(prepared);
    setPrepared(undefined);
  };
  return (
    <>
      <div class="sheet-head">
        <h2 id="operation-title">
          {reaches[info.name].icon} {reaches[info.name].label}
        </h2>
        <p class="sub">{info.summary}</p>
      </div>
      {prepared === undefined ? (
        <OperationForm info={info} seed={seed.draft} options={seed.options} submit={setPrepared} />
      ) : info.kind === "plan" || info.kind === "session" ? (
        <Review prepared={prepared} back={back} />
      ) : (
        <Query prepared={prepared} info={info} back={back} />
      )}
    </>
  );
};

export const OperationSheet = () => {
  const draft = selection.value;
  const sheet = useRef<HTMLDivElement>(null);
  const opened = draft !== undefined;
  useEffect(() => {
    if (!opened) return undefined;
    const previous = document.activeElement;
    sheet.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key === "Tab") {
        const focusable = sheet.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)",
        );
        const first = focusable?.[0];
        const last = focusable?.[focusable.length - 1];
        if (first === undefined) event.preventDefault();
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === sheet.current)) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    addEventListener("keydown", key);
    return () => {
      removeEventListener("keydown", key);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [opened]);
  if (draft === undefined) return null;
  const loaded = catalog.value;
  const info = loaded.state === "ready" ? loaded.value.find((item) => item.name === draft.name) : undefined;
  return (
    <div class="overlay" onClick={close}>
      <div
        ref={sheet}
        tabIndex={-1}
        class="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="operation-title"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        {loaded.state === "loading" ? (
          <Waiting what="Reading operations" />
        ) : loaded.state === "failed" ? (
          <Problem failure={loaded.failure} />
        ) : info === undefined ? (
          <p role="alert">Operation unavailable.</p>
        ) : (
          <Body key={JSON.stringify(draft)} draft={draft} info={info} />
        )}
      </div>
    </div>
  );
};
