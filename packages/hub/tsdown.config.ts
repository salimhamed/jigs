import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { main: "src/main.ts" },
  // Dev mode loads Vite from the package's own install, never a bundled copy.
  deps: { neverBundle: ["vite"] },
  fixedExtension: false,
});
