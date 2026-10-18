import { spawn } from "node:child_process";

/** How kayra shows itself: the operator's browser, behind an interface like every outside program. */
export type Opener = { readonly open: (url: string) => void };

/** macOS's open, xdg-open elsewhere; a browser that does not start leaves the printed URL. */
export const systemBrowser: Opener = {
  open: (url) => {
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true })
      .on("error", () => undefined)
      .unref();
  },
};
