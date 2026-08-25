import { createRequire as __wkfCreateRequire } from "node:module";
if (typeof globalThis.require === "undefined") globalThis.require = __wkfCreateRequire(import.meta.url);
import { n as __exportAll } from "../_runtime.mjs";
import { c as getWorld } from "./@workflow/core+[...].mjs";
//#region node_modules/.pnpm/workflow@4.8.4_@nestjs+common@11.2.1_reflect-metadata@0.2.2_rxjs@7.8.2_supports-color@8_a899a28bf884a3f8b456096100183003/node_modules/workflow/dist/stdlib.js
/**
* This is the "standard library" of steps that we make available to all workflow users.
* The can be imported like so: `import { fetch } from 'workflow'`. and used in workflow.
* The need to be exported directly in this package and cannot live in `core` to prevent
* circular dependencies post-compilation.
*/ /**
* A hoisted `fetch()` function that is executed as a "step" function,
* for use within workflow functions.
*
* @see https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API
*/ async function fetch(...args) {
	return globalThis.fetch(...args);
}
fetch.stepId = "step//workflow@4.8.4//fetch";
//#endregion
//#region node_modules/.pnpm/workflow@4.8.4_@nestjs+common@11.2.1_reflect-metadata@0.2.2_rxjs@7.8.2_supports-color@8_a899a28bf884a3f8b456096100183003/node_modules/workflow/dist/runtime.js
var runtime_exports = /* @__PURE__ */ __exportAll({ getWorld: () => getWorld });
//#endregion
export { runtime_exports as t };
