import { useEffect, useState } from "preact/hooks";
import type { DirectoryListing } from "../../../cli/src/clients/api/contract.gen.ts";
import { get, type Answer } from "../api.ts";
import { Problem, Waiting } from "./ui.tsx";

export const DirectoryPicker = ({
  initial,
  choose,
  close,
}: {
  readonly initial: string;
  readonly choose: (path: string) => void;
  readonly close: () => void;
}) => {
  const [path, setPath] = useState(initial === "" ? "." : initial);
  const [answer, setAnswer] = useState<Answer<DirectoryListing> | undefined>(undefined);
  useEffect(() => {
    const stop = { current: false };
    setAnswer(undefined);
    void get<DirectoryListing>(`/api/directories?path=${encodeURIComponent(path)}`).then((result) => {
      if (!stop.current) setAnswer(result);
    });
    return () => {
      stop.current = true;
    };
  }, [path]);
  return (
    <section class="directory-picker" aria-label="Choose a local directory">
      <div class="buttons">
        <strong>Choose a local directory</strong>
        <button type="button" class="button small" onClick={close}>
          Close picker
        </button>
      </div>
      {answer === undefined ? (
        <Waiting what="Reading directories" />
      ) : !answer.ok ? (
        <Problem failure={answer.failure} />
      ) : (
        <>
          <code class="directory-path">{answer.value.path}</code>
          <ul class="directory-list">
            {answer.value.parent === answer.value.path ? null : (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    setPath(answer.value.parent);
                  }}
                >
                  ↑ Parent directory
                </button>
              </li>
            )}
            {answer.value.directories.map((directory) => (
              <li key={directory.path}>
                <button
                  type="button"
                  onClick={() => {
                    setPath(directory.path);
                  }}
                >
                  ▸ {directory.name}
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            class="button"
            onClick={() => {
              choose(answer.value.path);
            }}
          >
            Use this directory
          </button>
        </>
      )}
    </section>
  );
};
