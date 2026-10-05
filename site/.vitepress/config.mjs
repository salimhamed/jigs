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
      { text: "Guide", link: "/guide/getting-started", activeMatch: "/guide/" },
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
          { text: "Install and run a workflow", link: "/guide/getting-started" },
          { text: "Why jigs", link: "/guide/why-jigs" },
          { text: "Core concepts", link: "/guide/concepts" },
        ],
      },
      {
        text: "Run a hub",
        collapsed: false,
        items: [
          { text: "Run a hub", link: "/guide/hub" },
          { text: "GitHub App", link: "/guide/hub-github" },
          { text: "Linear app", link: "/guide/hub-linear" },
          { text: "Slack app", link: "/guide/hub-slack" },
          { text: "PagerDuty app", link: "/guide/hub-pagerduty" },
        ],
      },
      {
        text: "Using jigs",
        collapsed: false,
        items: [
          { text: "Build a workflow", link: "/guide/build-a-workflow" },
          { text: "Models and harnesses", link: "/guide/models-and-harnesses" },
          { text: "Waiting and external events", link: "/guide/waiting-and-events" },
          { text: "Slack", link: "/guide/slack" },
          { text: "Recipes", link: "/guide/recipes" },
          { text: "Custom agent steps", link: "/guide/custom-agent-step" },
          { text: "Configuration", link: "/guide/configuration" },
          { text: "PagerDuty", link: "/guide/pagerduty" },
          { text: "Triage a PagerDuty incident", link: "/guide/pagerduty-incidents" },
          { text: "CLI commands", link: "/guide/cli" },
          { text: "Troubleshooting", link: "/guide/troubleshooting" },
        ],
      },
      { text: "API reference", link: "/api/", collapsed: true, items: apiSidebar },
    ],
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: "https://github.com/salimhamed/jigs" }],
    outline: [2, 3],
    footer: {
      message:
        'Licensed under the <a href="https://github.com/salimhamed/jigs/blob/main/LICENSE">Business Source License 1.1</a>. Each version converts to Apache License 2.0 after four years.',
    },
  },
};
