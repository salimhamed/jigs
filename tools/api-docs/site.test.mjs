import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { isPublicEntry, packageDir, rootDir } from "./docs.mjs";

// Its own file, so the site build runs beside the renderer tests in docs.test.mjs.
let destination;

afterAll(async () => {
  if (destination !== undefined) await rm(destination, { recursive: true, force: true });
});

test("the website covers the public entries, llms.txt and the favicon inside the Pages subpath", async () => {
  destination = await mkdtemp(path.join(os.tmpdir(), "jigs-api-docs-test-"));
  // Run the real build in Node so VitePress uses its own Vite version,
  // independently of Vitest's module loader.
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { renderSite } from ${JSON.stringify(new URL("./docs.mjs", import.meta.url).href)}; await renderSite(${JSON.stringify(destination)});`,
    ],
    { cwd: rootDir, stdio: "pipe" },
  );
  const manifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
  const generated = await readdir(destination, { recursive: true });
  const files = new Set(generated);
  expect(files.has("index.html")).toBe(true);
  expect(files.has("api/index.html")).toBe(true);
  expect(files.has("guide/getting-started.html")).toBe(true);
  const modulePages = generated.filter(
    (file) => file.startsWith("api/") && file.endsWith(".html") && file !== "api/index.html",
  );
  const publicSubpaths = Object.keys(manifest.exports).filter((subpath) =>
    isPublicEntry({ subpath }),
  );
  expect(modulePages.sort()).toEqual(
    [
      ...publicSubpaths.map((subpath) =>
        subpath === "." ? "api/jigs.html" : `api/${subpath.slice(2)}.html`,
      ),
      "api/factory/routines.html",
      "api/factory/steps.html",
    ].sort(),
  );

  const llms = await readFile(path.join(destination, "llms.txt"), "utf8");
  expect(llms).toContain("https://salimhamed.github.io/jigs/guide/getting-started.md");
  expect(llms).toContain("https://salimhamed.github.io/jigs/api/steps/agents.md");
  expect(llms).toContain("/jigs/guide/waiting-and-events.md");
  expect(llms).toContain("/jigs/api/factory/routines.md");
  expect(llms).toContain("/jigs/api/factory/steps.md");
  expect(llms).not.toContain("steps/human");
  expect(llms.indexOf("guide/getting-started.md")).toBeLessThan(llms.indexOf("guide/why-jigs.md"));
  expect(llms.indexOf("guide/models-and-harnesses.md")).toBeLessThan(
    llms.indexOf("guide/waiting-and-events.md"),
  );
  expect(llms).not.toMatch(/salimhamed\.github\.io\/(?!jigs\/)/);
  const llmsFull = await readFile(path.join(destination, "llms-full.txt"), "utf8");
  expect(llmsFull).toContain("# steps/agents");

  const landing = await readFile(path.join(destination, "index.html"), "utf8");
  expect(landing).toContain(`v${manifest.version}`);
  expect(landing).toContain("VPHomeHero");
  expect(landing).toContain('<link rel="icon" type="image/svg+xml" href="/jigs/favicon.svg">');
  expect(files.has("favicon.svg")).toBe(true);
  expect(landing).toContain("Search");
  expect(generated.some((file) => /assets\/.*localSearchIndex.*\.js$/.test(file))).toBe(true);
  const htmlPages = new Map(
    await Promise.all(
      generated
        .filter((file) => file.endsWith(".html"))
        .map(async (file) => [file, await readFile(path.join(destination, file), "utf8")]),
    ),
  );
  const pageIds = new Map(
    [...htmlPages].map(([file, html]) => {
      const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
      if (file.startsWith("api/")) {
        expect(
          ids.filter((id, index) => ids.indexOf(id) !== index),
          `${file}: duplicate HTML anchors`,
        ).toEqual([]);
      }
      return [file, new Set(ids)];
    }),
  );
  for (const [file, html] of htmlPages) {
    for (const [, href] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (/^[a-z][a-z\d+.-]*:/i.test(href)) continue;
      if (href.startsWith("/")) {
        expect(href, `${file}: ${href} must stay inside the Pages project`).toMatch(/^\/jigs\//);
      }
      const target = decodeURIComponent(href.split(/[?#]/)[0]);
      let relative = !target
        ? file
        : target.startsWith("/jigs/")
          ? target.slice("/jigs/".length)
          : path.normalize(path.join(path.dirname(file), target));
      if (!relative || relative.endsWith("/")) relative += "index.html";
      expect(files.has(relative), `${file}: missing ${href}`).toBe(true);
      const fragment = href.includes("#") ? decodeURIComponent(href.split("#")[1]) : "";
      if (fragment && pageIds.has(relative)) {
        expect(pageIds.get(relative).has(fragment), `${file}: missing anchor ${href}`).toBe(true);
      }
    }
  }
}, 60_000);
