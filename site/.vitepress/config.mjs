import manifest from "../../package.json" with { type: "json" };
import apiSidebar from "../api/typedoc-sidebar.json" with { type: "json" };

export default {
  title: "jigs",
  description: "Build repeatable workflows for coding agents.",
  lang: "en-US",
  base: "/jigs/",
  outDir: "../docs-site",
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/what-is-jigs", activeMatch: "/guide/" },
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
          { text: "What is jigs?", link: "/guide/what-is-jigs" },
          { text: "Your first workflow", link: "/guide/getting-started" },
          { text: "Core concepts", link: "/guide/concepts" },
        ],
      },
      {
        text: "Build workflows",
        collapsed: false,
        items: [
          { text: "Run an agent", link: "/guide/agents" },
          { text: "Call a model", link: "/guide/models" },
          { text: "Request human approval", link: "/guide/human-approval" },
          { text: "Use the ship recipe", link: "/guide/ship" },
        ],
      },
      {
        text: "Operate jigs",
        collapsed: false,
        items: [
          { text: "Setup and operations", link: "/guide/operations" },
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
