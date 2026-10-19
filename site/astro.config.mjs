// The docs site: Starlight for the text, LikeC4 for the architecture, whose
// model (model/*.c4) the views are generated from. Published to GitHub Pages
// under /kayra.
import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { LikeC4VitePlugin } from "likec4/vite-plugin";

export default defineConfig({
  site: "https://yunuseon.github.io",
  base: "/kayra",
  integrations: [
    starlight({
      title: "kayra",
      description: "A self-hosted app platform for running other people's apps safely, one server per customer, all of it as code.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/yunuseon/kayra" }],
      sidebar: [
        { label: "Start", items: [{ autogenerate: { directory: "start" } }] },
        { label: "Concepts", items: [{ autogenerate: { directory: "concepts" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
      ],
    }),
    react(),
  ],
  vite: { plugins: [LikeC4VitePlugin({ workspace: "model", ai: "disabled" })] },
});
