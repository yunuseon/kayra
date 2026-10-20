import type { Note, Remedy } from "../overview.ts";
import { refreshStatus, status } from "../state.ts";
import { openOperation } from "./operation.tsx";
import { Link } from "./shell.tsx";
import { Dot } from "./ui.tsx";

const RemedyButton = ({ remedy, first }: { readonly remedy: Remedy; readonly first: boolean }) => {
  const style = first ? "button small primary" : "button small";
  switch (remedy.kind) {
    case "run":
      return (
        <button type="button" class={style} onClick={() => { openOperation(remedy.draft.name, remedy.draft.input); }}>
          {remedy.label}
        </button>
      );
    case "go":
      return (
        <Link to={remedy.to} class={style}>
          {remedy.label}
        </Link>
      );
    case "ask":
      return (
        <button type="button" class={style} disabled={status.value.live} onClick={refreshStatus}>
          {status.value.live ? "asking…" : remedy.label}
        </button>
      );
  }
};

/** What needs the operator, each with what to do about it; a quiet line when nothing does. */
export const Notes = ({ notes, quiet }: { readonly notes: readonly Note[]; readonly quiet: string }) =>
  notes.length === 0 ? (
    <p class="note">
      <span class="note-title">
        <Dot tone="ok" /> nothing needs you
      </span>
      <span class="hint">{quiet}</span>
    </p>
  ) : (
    <div class="notes">
      {notes.map((note) => (
        <div key={note.title} class={`note note-${note.tone}`}>
          <div class="note-title">
            <Dot tone={note.tone === "active" ? "waiting" : note.tone} />
            <span>{note.title}</span>
          </div>
          {note.text === "" ? null : <p>{note.text}</p>}
          <div class="actions">
            {note.remedies.map((remedy, index) => (
              <RemedyButton key={remedy.label} remedy={remedy} first={index === 0} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
