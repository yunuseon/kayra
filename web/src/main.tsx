import { render } from "preact";
import { useEffect } from "preact/hooks";
import { Palette, openPalette } from "./components/palette.tsx";
import { PreviewSheet, show } from "./components/preview.tsx";
import { Shell } from "./components/shell.tsx";
import { loadFleet, refreshStatus, route } from "./state.ts";
import "./styles.css";
import { AppView } from "./views/app.tsx";
import { FleetView } from "./views/fleet.tsx";
import { RunView } from "./views/run.tsx";
import { RunsView } from "./views/runs.tsx";
import { ServerView } from "./views/server.tsx";
import { ValidateView } from "./views/validate.tsx";

const Page = () => {
  const current = route.value;
  switch (current.page) {
    case "fleet":
      return <FleetView />;
    case "server":
      return <ServerView name={current.server} />;
    case "app":
      return <AppView server={current.server} app={current.app} />;
    case "runs":
      return <RunsView />;
    case "run":
      return <RunView id={current.id} />;
    case "validate":
      return <ValidateView />;
    case "missing":
      return <p class="empty">Nothing at {current.path}.</p>;
  }
};

const App = () => {
  useEffect(() => {
    void loadFleet();
    refreshStatus();
  }, []);
  return (
    <>
      <Shell>
        <div class="topbar">
          <button class="search" onClick={openPalette}>
            <span>Go to, or run…</span>
            <kbd>⌘K</kbd>
          </button>
          <button class="button" onClick={() => { show({ name: "doctor" }); }}>
            Doctor
          </button>
        </div>
        <Page />
      </Shell>
      <PreviewSheet />
      <Palette />
    </>
  );
};

const root = document.getElementById("app");
if (root !== null) render(<App />, root);
