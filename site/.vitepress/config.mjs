import manifest from "../../package.json" with { type: "json" };
import { llmstxt } from "../../tools/api-docs/vitepress-plugins.mjs";
import apiSidebar from "../api/typedoc-sidebar.json" with { type: "json" };

const leaves = (items) => items.flatMap((item) => (item.items ? leaves(item.items) : [item]));

// vitepress-plugin-llms drops the base from links in nested sidebar groups,
// so llms.txt lists the API pages in one flat section.
const flattenNestedGroups = (sidebar) =>
  sidebar.map((section) =>
    section.items ? { ...section, items: leaves(section.items) } : section,
  );

export default {
  title: "jigs",
  description: "Build repeatable workflows for coding agents.",
  lang: "en-US",
  base: "/jigs/",
  outDir: "../docs-site",
  // VitePress does not prefix head links with the base.
  head: [["link", { rel: "icon", type: "image/svg+xml", href: "/jigs/favicon.svg" }]],
  vite: {
    plugins: [llmstxt({ domain: "https://salimhamed.github.io", sidebar: flattenNestedGroups })],
  },
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/why-jigs", activeMatch: "/guide/" },
      { text: "API reference", link: "/api/", activeMatch: "/api/" },
      {
        text: `v${manifest.version}`,
        link: `https://github.com/salimhamed/jigs/releases/tag/jigs-v${manifest.version}`,
      },
    ],
    sidebar: [
      {
        text: "Start here",
        collapsed: false,
        items: [
          { text: "Why jigs", link: "/guide/why-jigs" },
          { text: "Install and run a first workflow", link: "/guide/getting-started" },
          { text: "Core concepts", link: "/guide/concepts" },
        ],
      },
      {
        text: "Build",
        collapsed: false,
        items: [
          { text: "Build a workflow", link: "/guide/build-a-workflow" },
          { text: "Models and harnesses", link: "/guide/models-and-harnesses" },
          { text: "Recipes", link: "/guide/recipes" },
        ],
      },
      {
        text: "Operate",
        collapsed: false,
        items: [
          { text: "Configuration", link: "/guide/configuration" },
          { text: "CLI commands", link: "/guide/cli" },
          { text: "Troubleshooting", link: "/guide/troubleshooting" },
        ],
      },
      { text: "API reference", link: "/api/", collapsed: true, items: apiSidebar },
    ],
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: "https://github.com/salimhamed/jigs" }],
    outline: [2, 3],
    footer: { message: "Released under the MIT License." },
  },
};
