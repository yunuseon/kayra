import { defineConfig } from "vite";

// `npm run dev` beside `kayra ui --port 7700 --no-open`: the API is that server's,
// reached as if from its own page (its Host, its Origin), as kayra ui admits only those.
const api = "http://127.0.0.1:7700";
const asKayraUi = { target: api, configure: (proxy: { readonly on: (event: "proxyReq", listener: (request: { readonly setHeader: (name: string, value: string) => void }) => void) => void }) => {
  proxy.on("proxyReq", (request) => {
    request.setHeader("host", "127.0.0.1:7700");
    request.setHeader("origin", api);
  });
} };

export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  server: { proxy: { "/api": asKayraUi, "/login": asKayraUi } },
  build: { outDir: "dist", emptyOutDir: true, target: "es2023" },
});
