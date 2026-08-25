globalThis.__nitro_main__ = import.meta.url;
import { createRequire as __wkfCreateRequire } from "node:module";
if (typeof globalThis.require === "undefined") globalThis.require = __wkfCreateRequire(import.meta.url);
import { a as NodeResponse, i as toEventHandler, n as HTTPError, o as serve, r as defineHandler, t as H3Core } from "./_libs/h3+rou3+srvx.mjs";
import { t as HookableCore } from "./_libs/hookable.mjs";
import { i as withoutTrailingSlash, n as joinURL, r as withLeadingSlash, t as decodePath } from "./_libs/ufo.mjs";
import { t as Hono } from "./_libs/hono.mjs";
import { a as resumeHook, i as start, l as parseDurationToDate, n as stepEntrypoint, o as resumeWebhook, r as getRun, s as registerStepFunction, t as workflowEntrypoint } from "./_libs/@workflow/core+[...].mjs";
import "./_libs/workflow.mjs";
import { t as generateText } from "./_libs/ai.mjs";
import { t as claudeCode } from "./_libs/ai-sdk-provider-claude-code.mjs";
import { dirname, resolve } from "node:path";
import { promises } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
//#region workflows/gate.ts
async function gateWorkflow$1(gateId) {
	throw new Error("You attempted to execute workflow gateWorkflow function directly. To start a workflow, use start(gateWorkflow) from workflow/api");
}
gateWorkflow$1.workflowId = "workflow//./workflows/gate//gateWorkflow";
async function stepOne$1(gateId) {
	const marker = crypto.randomUUID();
	console.log(`[stepOne] executed gateId=${gateId} marker=${marker}`);
	return {
		gateId,
		marker,
		executedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
}
stepOne$1.stepId = "step//./workflows/gate//stepOne";
async function stepTwo$1(upstreamMarker, approval) {
	console.log(`[stepTwo] executed sawMarker=${upstreamMarker} approved=${approval.approved}`);
	return {
		sawMarker: upstreamMarker,
		completedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
}
stepTwo$1.stepId = "step//./workflows/gate//stepTwo";
//#endregion
//#region workflows/slow.ts
async function slowWorkflow$1(id, seconds) {
	throw new Error("You attempted to execute workflow slowWorkflow function directly. To start a workflow, use start(slowWorkflow) from workflow/api");
}
slowWorkflow$1.workflowId = "workflow//./workflows/slow//slowWorkflow";
async function slowStep$1(id, seconds) {
	const marker = crypto.randomUUID();
	console.log(`[slowStep] START id=${id} marker=${marker} pid=${process.pid} seconds=${seconds}`);
	await new Promise((r) => setTimeout(r, seconds * 1e3));
	console.log(`[slowStep] END id=${id} marker=${marker}`);
	return {
		id,
		marker,
		finishedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
}
slowStep$1.stepId = "step//./workflows/slow//slowStep";
async function afterStep$1(marker) {
	console.log(`[afterStep] executed sawMarker=${marker}`);
	return {
		sawMarker: marker,
		completedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
}
afterStep$1.stepId = "step//./workflows/slow//afterStep";
//#endregion
//#region workflows/probe.ts
async function serializationProbe$1() {
	throw new Error("You attempted to execute workflow serializationProbe function directly. To start a workflow, use start(serializationProbe) from workflow/api");
}
serializationProbe$1.workflowId = "workflow//./workflows/probe//serializationProbe";
async function probeStep$1(input) {
	console.log(`[probeStep] received:`, JSON.stringify(input));
	return {
		received: input,
		keys: Object.keys(input)
	};
}
probeStep$1.stepId = "step//./workflows/probe//probeStep";
//#endregion
//#region workflows/agent.ts
async function agentWorkflow$1(cfg) {
	throw new Error("You attempted to execute workflow agentWorkflow function directly. To start a workflow, use start(agentWorkflow) from workflow/api");
}
agentWorkflow$1.workflowId = "workflow//./workflows/agent//agentWorkflow";
async function setupStep$1(cwd) {
	await mkdir(cwd, { recursive: true });
	console.log(`[setupStep] workspace ready: ${cwd}`);
	return { cwd };
}
setupStep$1.stepId = "step//./workflows/agent//setupStep";
async function agentStep$1(cfg) {
	console.log(`[agentStep] START pid=${process.pid} cwd=${cfg.cwd} apiKeySet=${Boolean(process.env.ANTHROPIC_API_KEY)}`);
	const model = claudeCode(cfg.model, {
		cwd: cfg.cwd,
		permissionMode: "bypassPermissions",
		allowDangerouslySkipPermissions: true,
		maxTurns: 10,
		pathToClaudeCodeExecutable: cfg.claudeBinary
	});
	const startedAt = Date.now();
	const { text, usage } = await generateText({
		model,
		prompt: cfg.prompt
	});
	const elapsedMs = Date.now() - startedAt;
	console.log(`[agentStep] DONE in ${elapsedMs}ms`);
	return {
		text: text.slice(0, 800),
		usage,
		elapsedMs
	};
}
agentStep$1.stepId = "step//./workflows/agent//agentStep";
async function verifyStep$1(cwd, expectedFile) {
	const content = await readFile(`${cwd}/${expectedFile}`, "utf8");
	console.log(`[verifyStep] ${expectedFile} content: ${JSON.stringify(content)}`);
	return {
		expectedFile,
		content
	};
}
verifyStep$1.stepId = "step//./workflows/agent//verifyStep";
//#endregion
//#region src/index.ts
const app = new Hono();
app.post("/api/gate/start", async (c) => {
	const { id } = await c.req.json();
	const run = await start(gateWorkflow$1, [id]);
	return c.json({
		runId: run.runId,
		resumeToken: `gate:${id}`
	});
});
app.post("/api/gate/resume", async (c) => {
	const { id, approved, note } = await c.req.json();
	try {
		const result = await resumeHook(`gate:${id}`, {
			approved,
			note
		});
		return c.json({
			resumed: true,
			...result
		});
	} catch (err) {
		return c.json({
			resumed: false,
			error: String(err)
		}, 404);
	}
});
app.post("/api/slow/start", async (c) => {
	const { id, seconds = 90 } = await c.req.json();
	const run = await start(slowWorkflow$1, [id, seconds]);
	return c.json({ runId: run.runId });
});
app.post("/api/probe/start", async (c) => {
	const run = await start(serializationProbe$1, []);
	return c.json({ runId: run.runId });
});
app.post("/api/agent/start", async (c) => {
	const { id } = await c.req.json();
	const cwd = `${process.cwd()}/agent-scratch/${id}`;
	const run = await start(agentWorkflow$1, [{
		id,
		cwd,
		model: "haiku",
		prompt: "Create a file named hello.txt in the current directory containing exactly the text 'jigs-proto-ok' and nothing else. Then stop.",
		expectedFile: "hello.txt",
		claudeBinary: process.env.JIGS_PROTO_CLAUDE_BIN
	}]);
	return c.json({
		runId: run.runId,
		cwd
	});
});
app.get("/api/runs/:runId", async (c) => {
	const run = getRun(c.req.param("runId"));
	if (!await run.exists) return c.json({ error: "not found" }, 404);
	const status = await run.status;
	const body = {
		runId: run.runId,
		status
	};
	if (status === "completed") body.returnValue = await run.returnValue;
	return c.json(body);
});
//#endregion
//#region node_modules/.nitro/workflow/webhook.mjs
async function handler(request) {
	const pathParts = new URL(request.url).pathname.split("/");
	const token = decodeURIComponent(pathParts[pathParts.length - 1]);
	if (!token) return new Response("Missing token", { status: 400 });
	try {
		return await resumeWebhook(token, request);
	} catch (error) {
		console.error("Error during resumeWebhook", error);
		return new Response(null, { status: 404 });
	}
}
const POST$1 = handler;
//#endregion
//#region #workflow/webhook.mjs
var webhook_default = async ({ req }) => {
	try {
		return await POST$1(req);
	} catch (error) {
		console.error("Handler error:", error);
		return new Response("Internal Server Error", { status: 500 });
	}
};
//#endregion
//#region node_modules/.nitro/workflow/steps.mjs
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", {
	value,
	configurable: true
});
async function __builtin_response_array_buffer() {
	return this.arrayBuffer();
}
__name(__builtin_response_array_buffer, "__builtin_response_array_buffer");
async function __builtin_response_json() {
	return this.json();
}
__name(__builtin_response_json, "__builtin_response_json");
async function __builtin_response_text() {
	return this.text();
}
__name(__builtin_response_text, "__builtin_response_text");
registerStepFunction("__builtin_response_array_buffer", __builtin_response_array_buffer);
registerStepFunction("__builtin_response_json", __builtin_response_json);
registerStepFunction("__builtin_response_text", __builtin_response_text);
async function fetch(...args) {
	return globalThis.fetch(...args);
}
__name(fetch, "fetch");
registerStepFunction("step//workflow@4.8.4//fetch", fetch);
async function agentWorkflow(cfg) {
	throw new Error("You attempted to execute workflow agentWorkflow function directly. To start a workflow, use start(agentWorkflow) from workflow/api");
}
__name(agentWorkflow, "agentWorkflow");
agentWorkflow.workflowId = "workflow//./workflows/agent//agentWorkflow";
async function setupStep(cwd) {
	await mkdir(cwd, { recursive: true });
	console.log(`[setupStep] workspace ready: ${cwd}`);
	return { cwd };
}
__name(setupStep, "setupStep");
async function agentStep(cfg) {
	console.log(`[agentStep] START pid=${process.pid} cwd=${cfg.cwd} apiKeySet=${Boolean(process.env.ANTHROPIC_API_KEY)}`);
	const model = claudeCode(cfg.model, {
		cwd: cfg.cwd,
		permissionMode: "bypassPermissions",
		allowDangerouslySkipPermissions: true,
		maxTurns: 10,
		pathToClaudeCodeExecutable: cfg.claudeBinary
	});
	const startedAt = Date.now();
	const { text, usage } = await generateText({
		model,
		prompt: cfg.prompt
	});
	const elapsedMs = Date.now() - startedAt;
	console.log(`[agentStep] DONE in ${elapsedMs}ms`);
	return {
		text: text.slice(0, 800),
		usage,
		elapsedMs
	};
}
__name(agentStep, "agentStep");
async function verifyStep(cwd, expectedFile) {
	const content = await readFile(`${cwd}/${expectedFile}`, "utf8");
	console.log(`[verifyStep] ${expectedFile} content: ${JSON.stringify(content)}`);
	return {
		expectedFile,
		content
	};
}
__name(verifyStep, "verifyStep");
registerStepFunction("step//./workflows/agent//setupStep", setupStep);
registerStepFunction("step//./workflows/agent//agentStep", agentStep);
registerStepFunction("step//./workflows/agent//verifyStep", verifyStep);
async function gateWorkflow(gateId) {
	throw new Error("You attempted to execute workflow gateWorkflow function directly. To start a workflow, use start(gateWorkflow) from workflow/api");
}
__name(gateWorkflow, "gateWorkflow");
gateWorkflow.workflowId = "workflow//./workflows/gate//gateWorkflow";
async function stepOne(gateId) {
	const marker = crypto.randomUUID();
	console.log(`[stepOne] executed gateId=${gateId} marker=${marker}`);
	return {
		gateId,
		marker,
		executedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
}
__name(stepOne, "stepOne");
async function stepTwo(upstreamMarker, approval) {
	console.log(`[stepTwo] executed sawMarker=${upstreamMarker} approved=${approval.approved}`);
	return {
		sawMarker: upstreamMarker,
		completedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
}
__name(stepTwo, "stepTwo");
registerStepFunction("step//./workflows/gate//stepOne", stepOne);
registerStepFunction("step//./workflows/gate//stepTwo", stepTwo);
async function serializationProbe() {
	throw new Error("You attempted to execute workflow serializationProbe function directly. To start a workflow, use start(serializationProbe) from workflow/api");
}
__name(serializationProbe, "serializationProbe");
serializationProbe.workflowId = "workflow//./workflows/probe//serializationProbe";
async function probeStep(input) {
	console.log(`[probeStep] received:`, JSON.stringify(input));
	return {
		received: input,
		keys: Object.keys(input)
	};
}
__name(probeStep, "probeStep");
registerStepFunction("step//./workflows/probe//probeStep", probeStep);
async function slowWorkflow(id, seconds) {
	throw new Error("You attempted to execute workflow slowWorkflow function directly. To start a workflow, use start(slowWorkflow) from workflow/api");
}
__name(slowWorkflow, "slowWorkflow");
slowWorkflow.workflowId = "workflow//./workflows/slow//slowWorkflow";
async function slowStep(id, seconds) {
	const marker = crypto.randomUUID();
	console.log(`[slowStep] START id=${id} marker=${marker} pid=${process.pid} seconds=${seconds}`);
	await new Promise((r) => setTimeout(r, seconds * 1e3));
	console.log(`[slowStep] END id=${id} marker=${marker}`);
	return {
		id,
		marker,
		finishedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
}
__name(slowStep, "slowStep");
async function afterStep(marker) {
	console.log(`[afterStep] executed sawMarker=${marker}`);
	return {
		sawMarker: marker,
		completedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
}
__name(afterStep, "afterStep");
registerStepFunction("step//./workflows/slow//slowStep", slowStep);
registerStepFunction("step//./workflows/slow//afterStep", afterStep);
var BASE_URL = "https://useworkflow.dev/err";
function isError(value) {
	return typeof value === "object" && value !== null && "name" in value && "message" in value;
}
__name(isError, "isError");
var ERROR_SLUGS = {
	NODE_JS_MODULE_IN_WORKFLOW: "node-js-module-in-workflow",
	START_INVALID_WORKFLOW_FUNCTION: "start-invalid-workflow-function",
	SERIALIZATION_FAILED: "serialization-failed",
	WEBHOOK_INVALID_RESPOND_WITH_VALUE: "webhook-invalid-respond-with-value",
	WEBHOOK_RESPONSE_NOT_SENT: "webhook-response-not-sent",
	FETCH_IN_WORKFLOW_FUNCTION: "fetch-in-workflow",
	TIMEOUT_FUNCTIONS_IN_WORKFLOW: "timeout-in-workflow",
	HOOK_CONFLICT: "hook-conflict",
	CORRUPTED_EVENT_LOG: "corrupted-event-log",
	REPLAY_DIVERGENCE: "replay-divergence",
	STEP_NOT_REGISTERED: "step-not-registered",
	WORKFLOW_NOT_REGISTERED: "workflow-not-registered",
	RUNTIME_DECRYPTION_FAILED: "runtime-decryption-failed"
};
var WorkflowError = class extends Error {
	static {
		__name(this, "WorkflowError");
	}
	cause;
	constructor(message, options) {
		const msgDocs = options?.slug ? `${message}

Learn more: ${BASE_URL}/${options.slug}` : message;
		super(msgDocs, { cause: options?.cause });
		this.cause = options?.cause;
		if (options?.cause instanceof Error) this.stack = `${this.stack}
Caused by: ${options.cause.stack}`;
	}
	static is(value) {
		return isError(value) && value.name === "WorkflowError";
	}
};
var HookConflictError = class extends WorkflowError {
	static {
		__name(this, "HookConflictError");
	}
	token;
	conflictingRunId;
	constructor(token, conflictingRunId) {
		super(`Hook token "${token}" is already in use by another workflow${conflictingRunId ? ` (run "${conflictingRunId}")` : ""}`, { slug: ERROR_SLUGS.HOOK_CONFLICT });
		this.name = "HookConflictError";
		this.token = token;
		if (conflictingRunId !== void 0) this.conflictingRunId = conflictingRunId;
	}
	static is(value) {
		return isError(value) && value.name === "HookConflictError";
	}
};
var FatalError = class extends Error {
	static {
		__name(this, "FatalError");
	}
	fatal = true;
	constructor(message) {
		super(message);
		this.name = "FatalError";
	}
	static is(value) {
		return isError(value) && value.name === "FatalError";
	}
};
var RetryableError = class extends Error {
	static {
		__name(this, "RetryableError");
	}
	/**
	* The Date when the step should be retried.
	*/
	retryAfter;
	constructor(message, options = {}) {
		super(message);
		this.name = "RetryableError";
		if (options.retryAfter !== void 0) this.retryAfter = parseDurationToDate(options.retryAfter);
		else this.retryAfter = new Date(Date.now() + 1e3);
	}
	static is(value) {
		return isError(value) && value.name === "RetryableError";
	}
};
var FATAL_ERROR_KEY = /* @__PURE__ */ Symbol.for("@workflow/errors//FatalError");
var RETRYABLE_ERROR_KEY = /* @__PURE__ */ Symbol.for("@workflow/errors//RetryableError");
var HOOK_CONFLICT_ERROR_KEY = /* @__PURE__ */ Symbol.for("@workflow/errors//HookConflictError");
if (typeof globalThis !== "undefined") {
	if (!Object.hasOwn(globalThis, FATAL_ERROR_KEY)) Object.defineProperty(globalThis, FATAL_ERROR_KEY, {
		value: FatalError,
		writable: false,
		enumerable: false,
		configurable: false
	});
	if (!Object.hasOwn(globalThis, RETRYABLE_ERROR_KEY)) Object.defineProperty(globalThis, RETRYABLE_ERROR_KEY, {
		value: RetryableError,
		writable: false,
		enumerable: false,
		configurable: false
	});
	if (!Object.hasOwn(globalThis, HOOK_CONFLICT_ERROR_KEY)) Object.defineProperty(globalThis, HOOK_CONFLICT_ERROR_KEY, {
		value: HookConflictError,
		writable: false,
		enumerable: false,
		configurable: false
	});
}
//#endregion
//#region #workflow/steps.mjs
var steps_default = async ({ req }) => {
	try {
		return await stepEntrypoint(req);
	} catch (error) {
		console.error("Handler error:", error);
		return new Response("Internal Server Error", { status: 500 });
	}
};
const POST = workflowEntrypoint(`globalThis.__private_workflows = new Map();
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/.pnpm/ms@2.1.3/node_modules/ms/index.js
var require_ms = __commonJS({
  "node_modules/.pnpm/ms@2.1.3/node_modules/ms/index.js"(exports, module2) {
    var s = 1e3;
    var m = s * 60;
    var h = m * 60;
    var d = h * 24;
    var w = d * 7;
    var y = d * 365.25;
    module2.exports = function(val, options) {
      options = options || {};
      var type = typeof val;
      if (type === "string" && val.length > 0) {
        return parse(val);
      } else if (type === "number" && isFinite(val)) {
        return options.long ? fmtLong(val) : fmtShort(val);
      }
      throw new Error("val is not a non-empty string or a valid number. val=" + JSON.stringify(val));
    };
    function parse(str) {
      str = String(str);
      if (str.length > 100) {
        return;
      }
      var match = /^(-?(?:\\d+)?\\.?\\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?\$/i.exec(str);
      if (!match) {
        return;
      }
      var n = parseFloat(match[1]);
      var type = (match[2] || "ms").toLowerCase();
      switch (type) {
        case "years":
        case "year":
        case "yrs":
        case "yr":
        case "y":
          return n * y;
        case "weeks":
        case "week":
        case "w":
          return n * w;
        case "days":
        case "day":
        case "d":
          return n * d;
        case "hours":
        case "hour":
        case "hrs":
        case "hr":
        case "h":
          return n * h;
        case "minutes":
        case "minute":
        case "mins":
        case "min":
        case "m":
          return n * m;
        case "seconds":
        case "second":
        case "secs":
        case "sec":
        case "s":
          return n * s;
        case "milliseconds":
        case "millisecond":
        case "msecs":
        case "msec":
        case "ms":
          return n;
        default:
          return void 0;
      }
    }
    __name(parse, "parse");
    function fmtShort(ms2) {
      var msAbs = Math.abs(ms2);
      if (msAbs >= d) {
        return Math.round(ms2 / d) + "d";
      }
      if (msAbs >= h) {
        return Math.round(ms2 / h) + "h";
      }
      if (msAbs >= m) {
        return Math.round(ms2 / m) + "m";
      }
      if (msAbs >= s) {
        return Math.round(ms2 / s) + "s";
      }
      return ms2 + "ms";
    }
    __name(fmtShort, "fmtShort");
    function fmtLong(ms2) {
      var msAbs = Math.abs(ms2);
      if (msAbs >= d) {
        return plural(ms2, msAbs, d, "day");
      }
      if (msAbs >= h) {
        return plural(ms2, msAbs, h, "hour");
      }
      if (msAbs >= m) {
        return plural(ms2, msAbs, m, "minute");
      }
      if (msAbs >= s) {
        return plural(ms2, msAbs, s, "second");
      }
      return ms2 + " ms";
    }
    __name(fmtLong, "fmtLong");
    function plural(ms2, msAbs, n, name) {
      var isPlural = msAbs >= n * 1.5;
      return Math.round(ms2 / n) + " " + name + (isPlural ? "s" : "");
    }
    __name(plural, "plural");
  }
});

// workflows/agent.ts
async function agentWorkflow(cfg) {
  await setupStep(cfg.cwd);
  const agent = await agentStep(cfg);
  const verify = await verifyStep(cfg.cwd, cfg.expectedFile);
  return {
    agent,
    verify
  };
}
__name(agentWorkflow, "agentWorkflow");
agentWorkflow.workflowId = "workflow//./workflows/agent//agentWorkflow";
globalThis.__private_workflows.set("workflow//./workflows/agent//agentWorkflow", agentWorkflow);
var setupStep = globalThis[/* @__PURE__ */ Symbol.for("WORKFLOW_USE_STEP")]("step//./workflows/agent//setupStep");
var agentStep = globalThis[/* @__PURE__ */ Symbol.for("WORKFLOW_USE_STEP")]("step//./workflows/agent//agentStep");
var verifyStep = globalThis[/* @__PURE__ */ Symbol.for("WORKFLOW_USE_STEP")]("step//./workflows/agent//verifyStep");

// node_modules/.pnpm/@workflow+utils@4.1.4/node_modules/@workflow/utils/dist/time.js
var import_ms = __toESM(require_ms(), 1);
function parseDurationToDate(param) {
  if (typeof param === "string") {
    const durationMs = (0, import_ms.default)(param);
    if (typeof durationMs !== "number" || durationMs < 0) {
      throw new Error(\`Invalid duration: "\${param}". Expected a valid duration string like "1s", "1m", "1h", etc.\`);
    }
    return new Date(Date.now() + durationMs);
  } else if (typeof param === "number") {
    if (param < 0 || !Number.isFinite(param)) {
      throw new Error(\`Invalid duration: \${param}. Expected a non-negative finite number of milliseconds.\`);
    }
    return new Date(Date.now() + param);
  } else if (param instanceof Date || param && typeof param === "object" && typeof param.getTime === "function") {
    return param instanceof Date ? param : new Date(param.getTime());
  } else {
    throw new Error(\`Invalid duration parameter. Expected a duration string, number (milliseconds), or Date object.\`);
  }
}
__name(parseDurationToDate, "parseDurationToDate");

// node_modules/.pnpm/@workflow+errors@4.2.1/node_modules/@workflow/errors/dist/index.js
var BASE_URL = "https://useworkflow.dev/err";
function isError(value) {
  return typeof value === "object" && value !== null && "name" in value && "message" in value;
}
__name(isError, "isError");
var ERROR_SLUGS = {
  NODE_JS_MODULE_IN_WORKFLOW: "node-js-module-in-workflow",
  START_INVALID_WORKFLOW_FUNCTION: "start-invalid-workflow-function",
  SERIALIZATION_FAILED: "serialization-failed",
  WEBHOOK_INVALID_RESPOND_WITH_VALUE: "webhook-invalid-respond-with-value",
  WEBHOOK_RESPONSE_NOT_SENT: "webhook-response-not-sent",
  FETCH_IN_WORKFLOW_FUNCTION: "fetch-in-workflow",
  TIMEOUT_FUNCTIONS_IN_WORKFLOW: "timeout-in-workflow",
  HOOK_CONFLICT: "hook-conflict",
  CORRUPTED_EVENT_LOG: "corrupted-event-log",
  REPLAY_DIVERGENCE: "replay-divergence",
  STEP_NOT_REGISTERED: "step-not-registered",
  WORKFLOW_NOT_REGISTERED: "workflow-not-registered",
  RUNTIME_DECRYPTION_FAILED: "runtime-decryption-failed"
};
var WorkflowError = class extends Error {
  static {
    __name(this, "WorkflowError");
  }
  cause;
  constructor(message, options) {
    const msgDocs = options?.slug ? \`\${message}

Learn more: \${BASE_URL}/\${options.slug}\` : message;
    super(msgDocs, {
      cause: options?.cause
    });
    this.cause = options?.cause;
    if (options?.cause instanceof Error) {
      this.stack = \`\${this.stack}
Caused by: \${options.cause.stack}\`;
    }
  }
  static is(value) {
    return isError(value) && value.name === "WorkflowError";
  }
};
var HookConflictError = class extends WorkflowError {
  static {
    __name(this, "HookConflictError");
  }
  token;
  // TODO: Make this required once all persisted hook_conflict events and World
  // implementations always include the active hook owner's run ID.
  conflictingRunId;
  constructor(token, conflictingRunId) {
    super(\`Hook token "\${token}" is already in use by another workflow\${conflictingRunId ? \` (run "\${conflictingRunId}")\` : ""}\`, {
      slug: ERROR_SLUGS.HOOK_CONFLICT
    });
    this.name = "HookConflictError";
    this.token = token;
    if (conflictingRunId !== void 0) {
      this.conflictingRunId = conflictingRunId;
    }
  }
  static is(value) {
    return isError(value) && value.name === "HookConflictError";
  }
};
var FatalError = class extends Error {
  static {
    __name(this, "FatalError");
  }
  fatal = true;
  constructor(message) {
    super(message);
    this.name = "FatalError";
  }
  static is(value) {
    return isError(value) && value.name === "FatalError";
  }
};
var RetryableError = class extends Error {
  static {
    __name(this, "RetryableError");
  }
  /**
   * The Date when the step should be retried.
   */
  retryAfter;
  constructor(message, options = {}) {
    super(message);
    this.name = "RetryableError";
    if (options.retryAfter !== void 0) {
      this.retryAfter = parseDurationToDate(options.retryAfter);
    } else {
      this.retryAfter = new Date(Date.now() + 1e3);
    }
  }
  static is(value) {
    return isError(value) && value.name === "RetryableError";
  }
};
var FATAL_ERROR_KEY = /* @__PURE__ */ Symbol.for("@workflow/errors//FatalError");
var RETRYABLE_ERROR_KEY = /* @__PURE__ */ Symbol.for("@workflow/errors//RetryableError");
var HOOK_CONFLICT_ERROR_KEY = /* @__PURE__ */ Symbol.for("@workflow/errors//HookConflictError");
if (typeof globalThis !== "undefined") {
  if (!Object.hasOwn(globalThis, FATAL_ERROR_KEY)) {
    Object.defineProperty(globalThis, FATAL_ERROR_KEY, {
      value: FatalError,
      writable: false,
      enumerable: false,
      configurable: false
    });
  }
  if (!Object.hasOwn(globalThis, RETRYABLE_ERROR_KEY)) {
    Object.defineProperty(globalThis, RETRYABLE_ERROR_KEY, {
      value: RetryableError,
      writable: false,
      enumerable: false,
      configurable: false
    });
  }
  if (!Object.hasOwn(globalThis, HOOK_CONFLICT_ERROR_KEY)) {
    Object.defineProperty(globalThis, HOOK_CONFLICT_ERROR_KEY, {
      value: HookConflictError,
      writable: false,
      enumerable: false,
      configurable: false
    });
  }
}

// node_modules/.pnpm/@workflow+core@4.8.4_supports-color@8.1.1/node_modules/@workflow/core/dist/symbols.js
var WORKFLOW_CREATE_HOOK = /* @__PURE__ */ Symbol.for("WORKFLOW_CREATE_HOOK");

// node_modules/.pnpm/@workflow+core@4.8.4_supports-color@8.1.1/node_modules/@workflow/core/dist/workflow/create-hook.js
function createHook(options) {
  const createHookFn = globalThis[WORKFLOW_CREATE_HOOK];
  if (!createHookFn) {
    throw new Error("\`createHook()\` can only be called inside a workflow function");
  }
  return createHookFn(options);
}
__name(createHook, "createHook");

// node_modules/.pnpm/workflow@4.8.4_@nestjs+common@11.2.1_reflect-metadata@0.2.2_rxjs@7.8.2_supports-color@8_a899a28bf884a3f8b456096100183003/node_modules/workflow/dist/stdlib.js
var fetch = globalThis[/* @__PURE__ */ Symbol.for("WORKFLOW_USE_STEP")]("step//workflow@4.8.4//fetch");

// workflows/gate.ts
function _ts_add_disposable_resource(env, value, async) {
  if (value !== null && value !== void 0) {
    if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
    var dispose, inner;
    if (async) {
      if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
      dispose = value[Symbol.asyncDispose];
    }
    if (dispose === void 0) {
      if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
      dispose = value[Symbol.dispose];
      if (async) inner = dispose;
    }
    if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
    if (inner) dispose = /* @__PURE__ */ __name(function() {
      try {
        inner.call(this);
      } catch (e) {
        return Promise.reject(e);
      }
    }, "dispose");
    env.stack.push({
      value,
      dispose,
      async
    });
  } else if (async) {
    env.stack.push({
      async: true
    });
  }
  return value;
}
__name(_ts_add_disposable_resource, "_ts_add_disposable_resource");
function _ts_dispose_resources(env) {
  var _SuppressedError = typeof SuppressedError === "function" ? SuppressedError : function(error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
  };
  return (_ts_dispose_resources = /* @__PURE__ */ __name(function _ts_dispose_resources2(env2) {
    function fail(e) {
      env2.error = env2.hasError ? new _SuppressedError(e, env2.error, "An error was suppressed during disposal.") : e;
      env2.hasError = true;
    }
    __name(fail, "fail");
    var r, s = 0;
    function next() {
      while (r = env2.stack.pop()) {
        try {
          if (!r.async && s === 1) return s = 0, env2.stack.push(r), Promise.resolve().then(next);
          if (r.dispose) {
            var result = r.dispose.call(r.value);
            if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) {
              fail(e);
              return next();
            });
          } else s |= 1;
        } catch (e) {
          fail(e);
        }
      }
      if (s === 1) return env2.hasError ? Promise.reject(env2.error) : Promise.resolve();
      if (env2.hasError) throw env2.error;
    }
    __name(next, "next");
    return next();
  }, "_ts_dispose_resources"))(env);
}
__name(_ts_dispose_resources, "_ts_dispose_resources");
async function gateWorkflow(gateId) {
  const env = {
    stack: [],
    error: void 0,
    hasError: false
  };
  try {
    const one = await stepOne(gateId);
    const hook = _ts_add_disposable_resource(env, createHook({
      token: \`gate:\${gateId}\`
    }), false);
    const approval = await hook;
    const two = await stepTwo(one.marker, approval);
    return {
      stepOne: one,
      approval,
      stepTwo: two
    };
  } catch (e) {
    env.error = e;
    env.hasError = true;
  } finally {
    _ts_dispose_resources(env);
  }
}
__name(gateWorkflow, "gateWorkflow");
gateWorkflow.workflowId = "workflow//./workflows/gate//gateWorkflow";
globalThis.__private_workflows.set("workflow//./workflows/gate//gateWorkflow", gateWorkflow);
var stepOne = globalThis[/* @__PURE__ */ Symbol.for("WORKFLOW_USE_STEP")]("step//./workflows/gate//stepOne");
var stepTwo = globalThis[/* @__PURE__ */ Symbol.for("WORKFLOW_USE_STEP")]("step//./workflows/gate//stepTwo");

// workflows/probe.ts
async function serializationProbe() {
  const liveObject = {
    label: "live-object",
    fn: /* @__PURE__ */ __name(() => 42, "fn")
  };
  const result = await probeStep(liveObject);
  return {
    result
  };
}
__name(serializationProbe, "serializationProbe");
serializationProbe.workflowId = "workflow//./workflows/probe//serializationProbe";
globalThis.__private_workflows.set("workflow//./workflows/probe//serializationProbe", serializationProbe);
var probeStep = globalThis[/* @__PURE__ */ Symbol.for("WORKFLOW_USE_STEP")]("step//./workflows/probe//probeStep");

// workflows/slow.ts
async function slowWorkflow(id, seconds) {
  const one = await slowStep(id, seconds);
  const two = await afterStep(one.marker);
  return {
    slowStep: one,
    afterStep: two
  };
}
__name(slowWorkflow, "slowWorkflow");
slowWorkflow.workflowId = "workflow//./workflows/slow//slowWorkflow";
globalThis.__private_workflows.set("workflow//./workflows/slow//slowWorkflow", slowWorkflow);
var slowStep = globalThis[/* @__PURE__ */ Symbol.for("WORKFLOW_USE_STEP")]("step//./workflows/slow//slowStep");
var afterStep = globalThis[/* @__PURE__ */ Symbol.for("WORKFLOW_USE_STEP")]("step//./workflows/slow//afterStep");
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsibm9kZV9tb2R1bGVzLy5wbnBtL21zQDIuMS4zL25vZGVfbW9kdWxlcy9tcy9pbmRleC5qcyIsICJ3b3JrZmxvd3MvYWdlbnQudHMiLCAibm9kZV9tb2R1bGVzLy5wbnBtL0B3b3JrZmxvdyt1dGlsc0A0LjEuNC9ub2RlX21vZHVsZXMvQHdvcmtmbG93L3V0aWxzL3NyYy90aW1lLnRzIiwgIm5vZGVfbW9kdWxlcy8ucG5wbS9Ad29ya2Zsb3crZXJyb3JzQDQuMi4xL25vZGVfbW9kdWxlcy9Ad29ya2Zsb3cvZXJyb3JzL3NyYy9pbmRleC50cyIsICJub2RlX21vZHVsZXMvLnBucG0vQHdvcmtmbG93K2NvcmVANC44LjRfc3VwcG9ydHMtY29sb3JAOC4xLjEvbm9kZV9tb2R1bGVzL0B3b3JrZmxvdy9jb3JlL3NyYy9zeW1ib2xzLnRzIiwgIm5vZGVfbW9kdWxlcy8ucG5wbS9Ad29ya2Zsb3crY29yZUA0LjguNF9zdXBwb3J0cy1jb2xvckA4LjEuMS9ub2RlX21vZHVsZXMvQHdvcmtmbG93L2NvcmUvc3JjL3dvcmtmbG93L2NyZWF0ZS1ob29rLnRzIiwgIm5vZGVfbW9kdWxlcy8ucG5wbS93b3JrZmxvd0A0LjguNF9AbmVzdGpzK2NvbW1vbkAxMS4yLjFfcmVmbGVjdC1tZXRhZGF0YUAwLjIuMl9yeGpzQDcuOC4yX3N1cHBvcnRzLWNvbG9yQDhfYTg5OWEyOGJmODg0YTNmOGI0NTYwOTYxMDAxODMwMDMvbm9kZV9tb2R1bGVzL3dvcmtmbG93L3NyYy9zdGRsaWIudHMiLCAid29ya2Zsb3dzL2dhdGUudHMiLCAid29ya2Zsb3dzL3Byb2JlLnRzIiwgIndvcmtmbG93cy9zbG93LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEhlbHBlcnMuXG4gKi8gdmFyIHMgPSAxMDAwO1xudmFyIG0gPSBzICogNjA7XG52YXIgaCA9IG0gKiA2MDtcbnZhciBkID0gaCAqIDI0O1xudmFyIHcgPSBkICogNztcbnZhciB5ID0gZCAqIDM2NS4yNTtcbi8qKlxuICogUGFyc2Ugb3IgZm9ybWF0IHRoZSBnaXZlbiBgdmFsYC5cbiAqXG4gKiBPcHRpb25zOlxuICpcbiAqICAtIGBsb25nYCB2ZXJib3NlIGZvcm1hdHRpbmcgW2ZhbHNlXVxuICpcbiAqIEBwYXJhbSB7U3RyaW5nfE51bWJlcn0gdmFsXG4gKiBAcGFyYW0ge09iamVjdH0gW29wdGlvbnNdXG4gKiBAdGhyb3dzIHtFcnJvcn0gdGhyb3cgYW4gZXJyb3IgaWYgdmFsIGlzIG5vdCBhIG5vbi1lbXB0eSBzdHJpbmcgb3IgYSBudW1iZXJcbiAqIEByZXR1cm4ge1N0cmluZ3xOdW1iZXJ9XG4gKiBAYXBpIHB1YmxpY1xuICovIG1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24odmFsLCBvcHRpb25zKSB7XG4gICAgb3B0aW9ucyA9IG9wdGlvbnMgfHwge307XG4gICAgdmFyIHR5cGUgPSB0eXBlb2YgdmFsO1xuICAgIGlmICh0eXBlID09PSAnc3RyaW5nJyAmJiB2YWwubGVuZ3RoID4gMCkge1xuICAgICAgICByZXR1cm4gcGFyc2UodmFsKTtcbiAgICB9IGVsc2UgaWYgKHR5cGUgPT09ICdudW1iZXInICYmIGlzRmluaXRlKHZhbCkpIHtcbiAgICAgICAgcmV0dXJuIG9wdGlvbnMubG9uZyA/IGZtdExvbmcodmFsKSA6IGZtdFNob3J0KHZhbCk7XG4gICAgfVxuICAgIHRocm93IG5ldyBFcnJvcigndmFsIGlzIG5vdCBhIG5vbi1lbXB0eSBzdHJpbmcgb3IgYSB2YWxpZCBudW1iZXIuIHZhbD0nICsgSlNPTi5zdHJpbmdpZnkodmFsKSk7XG59O1xuLyoqXG4gKiBQYXJzZSB0aGUgZ2l2ZW4gYHN0cmAgYW5kIHJldHVybiBtaWxsaXNlY29uZHMuXG4gKlxuICogQHBhcmFtIHtTdHJpbmd9IHN0clxuICogQHJldHVybiB7TnVtYmVyfVxuICogQGFwaSBwcml2YXRlXG4gKi8gZnVuY3Rpb24gcGFyc2Uoc3RyKSB7XG4gICAgc3RyID0gU3RyaW5nKHN0cik7XG4gICAgaWYgKHN0ci5sZW5ndGggPiAxMDApIHtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB2YXIgbWF0Y2ggPSAvXigtPyg/OlxcZCspP1xcLj9cXGQrKSAqKG1pbGxpc2Vjb25kcz98bXNlY3M/fG1zfHNlY29uZHM/fHNlY3M/fHN8bWludXRlcz98bWlucz98bXxob3Vycz98aHJzP3xofGRheXM/fGR8d2Vla3M/fHd8eWVhcnM/fHlycz98eSk/JC9pLmV4ZWMoc3RyKTtcbiAgICBpZiAoIW1hdGNoKSB7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdmFyIG4gPSBwYXJzZUZsb2F0KG1hdGNoWzFdKTtcbiAgICB2YXIgdHlwZSA9IChtYXRjaFsyXSB8fCAnbXMnKS50b0xvd2VyQ2FzZSgpO1xuICAgIHN3aXRjaCh0eXBlKXtcbiAgICAgICAgY2FzZSAneWVhcnMnOlxuICAgICAgICBjYXNlICd5ZWFyJzpcbiAgICAgICAgY2FzZSAneXJzJzpcbiAgICAgICAgY2FzZSAneXInOlxuICAgICAgICBjYXNlICd5JzpcbiAgICAgICAgICAgIHJldHVybiBuICogeTtcbiAgICAgICAgY2FzZSAnd2Vla3MnOlxuICAgICAgICBjYXNlICd3ZWVrJzpcbiAgICAgICAgY2FzZSAndyc6XG4gICAgICAgICAgICByZXR1cm4gbiAqIHc7XG4gICAgICAgIGNhc2UgJ2RheXMnOlxuICAgICAgICBjYXNlICdkYXknOlxuICAgICAgICBjYXNlICdkJzpcbiAgICAgICAgICAgIHJldHVybiBuICogZDtcbiAgICAgICAgY2FzZSAnaG91cnMnOlxuICAgICAgICBjYXNlICdob3VyJzpcbiAgICAgICAgY2FzZSAnaHJzJzpcbiAgICAgICAgY2FzZSAnaHInOlxuICAgICAgICBjYXNlICdoJzpcbiAgICAgICAgICAgIHJldHVybiBuICogaDtcbiAgICAgICAgY2FzZSAnbWludXRlcyc6XG4gICAgICAgIGNhc2UgJ21pbnV0ZSc6XG4gICAgICAgIGNhc2UgJ21pbnMnOlxuICAgICAgICBjYXNlICdtaW4nOlxuICAgICAgICBjYXNlICdtJzpcbiAgICAgICAgICAgIHJldHVybiBuICogbTtcbiAgICAgICAgY2FzZSAnc2Vjb25kcyc6XG4gICAgICAgIGNhc2UgJ3NlY29uZCc6XG4gICAgICAgIGNhc2UgJ3NlY3MnOlxuICAgICAgICBjYXNlICdzZWMnOlxuICAgICAgICBjYXNlICdzJzpcbiAgICAgICAgICAgIHJldHVybiBuICogcztcbiAgICAgICAgY2FzZSAnbWlsbGlzZWNvbmRzJzpcbiAgICAgICAgY2FzZSAnbWlsbGlzZWNvbmQnOlxuICAgICAgICBjYXNlICdtc2Vjcyc6XG4gICAgICAgIGNhc2UgJ21zZWMnOlxuICAgICAgICBjYXNlICdtcyc6XG4gICAgICAgICAgICByZXR1cm4gbjtcbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgfVxufVxuLyoqXG4gKiBTaG9ydCBmb3JtYXQgZm9yIGBtc2AuXG4gKlxuICogQHBhcmFtIHtOdW1iZXJ9IG1zXG4gKiBAcmV0dXJuIHtTdHJpbmd9XG4gKiBAYXBpIHByaXZhdGVcbiAqLyBmdW5jdGlvbiBmbXRTaG9ydChtcykge1xuICAgIHZhciBtc0FicyA9IE1hdGguYWJzKG1zKTtcbiAgICBpZiAobXNBYnMgPj0gZCkge1xuICAgICAgICByZXR1cm4gTWF0aC5yb3VuZChtcyAvIGQpICsgJ2QnO1xuICAgIH1cbiAgICBpZiAobXNBYnMgPj0gaCkge1xuICAgICAgICByZXR1cm4gTWF0aC5yb3VuZChtcyAvIGgpICsgJ2gnO1xuICAgIH1cbiAgICBpZiAobXNBYnMgPj0gbSkge1xuICAgICAgICByZXR1cm4gTWF0aC5yb3VuZChtcyAvIG0pICsgJ20nO1xuICAgIH1cbiAgICBpZiAobXNBYnMgPj0gcykge1xuICAgICAgICByZXR1cm4gTWF0aC5yb3VuZChtcyAvIHMpICsgJ3MnO1xuICAgIH1cbiAgICByZXR1cm4gbXMgKyAnbXMnO1xufVxuLyoqXG4gKiBMb25nIGZvcm1hdCBmb3IgYG1zYC5cbiAqXG4gKiBAcGFyYW0ge051bWJlcn0gbXNcbiAqIEByZXR1cm4ge1N0cmluZ31cbiAqIEBhcGkgcHJpdmF0ZVxuICovIGZ1bmN0aW9uIGZtdExvbmcobXMpIHtcbiAgICB2YXIgbXNBYnMgPSBNYXRoLmFicyhtcyk7XG4gICAgaWYgKG1zQWJzID49IGQpIHtcbiAgICAgICAgcmV0dXJuIHBsdXJhbChtcywgbXNBYnMsIGQsICdkYXknKTtcbiAgICB9XG4gICAgaWYgKG1zQWJzID49IGgpIHtcbiAgICAgICAgcmV0dXJuIHBsdXJhbChtcywgbXNBYnMsIGgsICdob3VyJyk7XG4gICAgfVxuICAgIGlmIChtc0FicyA+PSBtKSB7XG4gICAgICAgIHJldHVybiBwbHVyYWwobXMsIG1zQWJzLCBtLCAnbWludXRlJyk7XG4gICAgfVxuICAgIGlmIChtc0FicyA+PSBzKSB7XG4gICAgICAgIHJldHVybiBwbHVyYWwobXMsIG1zQWJzLCBzLCAnc2Vjb25kJyk7XG4gICAgfVxuICAgIHJldHVybiBtcyArICcgbXMnO1xufVxuLyoqXG4gKiBQbHVyYWxpemF0aW9uIGhlbHBlci5cbiAqLyBmdW5jdGlvbiBwbHVyYWwobXMsIG1zQWJzLCBuLCBuYW1lKSB7XG4gICAgdmFyIGlzUGx1cmFsID0gbXNBYnMgPj0gbiAqIDEuNTtcbiAgICByZXR1cm4gTWF0aC5yb3VuZChtcyAvIG4pICsgJyAnICsgbmFtZSArIChpc1BsdXJhbCA/ICdzJyA6ICcnKTtcbn1cbiIsICIvKipfX2ludGVybmFsX3dvcmtmbG93c3tcIndvcmtmbG93c1wiOntcIndvcmtmbG93cy9hZ2VudC50c1wiOntcImFnZW50V29ya2Zsb3dcIjp7XCJ3b3JrZmxvd0lkXCI6XCJ3b3JrZmxvdy8vLi93b3JrZmxvd3MvYWdlbnQvL2FnZW50V29ya2Zsb3dcIn19fSxcInN0ZXBzXCI6e1wid29ya2Zsb3dzL2FnZW50LnRzXCI6e1wiYWdlbnRTdGVwXCI6e1wic3RlcElkXCI6XCJzdGVwLy8uL3dvcmtmbG93cy9hZ2VudC8vYWdlbnRTdGVwXCJ9LFwic2V0dXBTdGVwXCI6e1wic3RlcElkXCI6XCJzdGVwLy8uL3dvcmtmbG93cy9hZ2VudC8vc2V0dXBTdGVwXCJ9LFwidmVyaWZ5U3RlcFwiOntcInN0ZXBJZFwiOlwic3RlcC8vLi93b3JrZmxvd3MvYWdlbnQvL3ZlcmlmeVN0ZXBcIn19fX0qLztcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhZ2VudFdvcmtmbG93KGNmZykge1xuICAgIGF3YWl0IHNldHVwU3RlcChjZmcuY3dkKTtcbiAgICBjb25zdCBhZ2VudCA9IGF3YWl0IGFnZW50U3RlcChjZmcpO1xuICAgIGNvbnN0IHZlcmlmeSA9IGF3YWl0IHZlcmlmeVN0ZXAoY2ZnLmN3ZCwgY2ZnLmV4cGVjdGVkRmlsZSk7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgYWdlbnQsXG4gICAgICAgIHZlcmlmeVxuICAgIH07XG59XG5hZ2VudFdvcmtmbG93LndvcmtmbG93SWQgPSBcIndvcmtmbG93Ly8uL3dvcmtmbG93cy9hZ2VudC8vYWdlbnRXb3JrZmxvd1wiO1xuZ2xvYmFsVGhpcy5fX3ByaXZhdGVfd29ya2Zsb3dzLnNldChcIndvcmtmbG93Ly8uL3dvcmtmbG93cy9hZ2VudC8vYWdlbnRXb3JrZmxvd1wiLCBhZ2VudFdvcmtmbG93KTtcbnZhciBzZXR1cFN0ZXAgPSBnbG9iYWxUaGlzW1N5bWJvbC5mb3IoXCJXT1JLRkxPV19VU0VfU1RFUFwiKV0oXCJzdGVwLy8uL3dvcmtmbG93cy9hZ2VudC8vc2V0dXBTdGVwXCIpO1xudmFyIGFnZW50U3RlcCA9IGdsb2JhbFRoaXNbU3ltYm9sLmZvcihcIldPUktGTE9XX1VTRV9TVEVQXCIpXShcInN0ZXAvLy4vd29ya2Zsb3dzL2FnZW50Ly9hZ2VudFN0ZXBcIik7XG52YXIgdmVyaWZ5U3RlcCA9IGdsb2JhbFRoaXNbU3ltYm9sLmZvcihcIldPUktGTE9XX1VTRV9TVEVQXCIpXShcInN0ZXAvLy4vd29ya2Zsb3dzL2FnZW50Ly92ZXJpZnlTdGVwXCIpO1xuIiwgImltcG9ydCB0eXBlIHsgU3RyaW5nVmFsdWUgfSBmcm9tICdtcyc7XG5pbXBvcnQgbXMgZnJvbSAnbXMnO1xuXG4vKipcbiAqIFBhcnNlcyBhIGR1cmF0aW9uIHBhcmFtZXRlciAoc3RyaW5nLCBudW1iZXIsIG9yIERhdGUpIGFuZCByZXR1cm5zIGEgRGF0ZSBvYmplY3RcbiAqIHJlcHJlc2VudGluZyB3aGVuIHRoZSBkdXJhdGlvbiBzaG91bGQgZWxhcHNlLlxuICpcbiAqIC0gRm9yIHN0cmluZ3M6IFBhcnNlcyBkdXJhdGlvbiBzdHJpbmdzIGxpa2UgXCIxc1wiLCBcIjVtXCIsIFwiMWhcIiwgZXRjLiB1c2luZyB0aGUgYG1zYCBsaWJyYXJ5XG4gKiAtIEZvciBudW1iZXJzOiBUcmVhdHMgYXMgbWlsbGlzZWNvbmRzIGZyb20gbm93XG4gKiAtIEZvciBEYXRlIG9iamVjdHM6IFJldHVybnMgdGhlIGRhdGUgZGlyZWN0bHkgKGhhbmRsZXMgYm90aCBEYXRlIGluc3RhbmNlcyBhbmQgZGF0ZS1saWtlIG9iamVjdHMgZnJvbSBkZXNlcmlhbGl6YXRpb24pXG4gKlxuICogQHBhcmFtIHBhcmFtIC0gVGhlIGR1cmF0aW9uIHBhcmFtZXRlciAoU3RyaW5nVmFsdWUsIERhdGUsIG9yIG51bWJlciBvZiBtaWxsaXNlY29uZHMpXG4gKiBAcmV0dXJucyBBIERhdGUgb2JqZWN0IHJlcHJlc2VudGluZyB3aGVuIHRoZSBkdXJhdGlvbiBzaG91bGQgZWxhcHNlXG4gKiBAdGhyb3dzIHtFcnJvcn0gSWYgdGhlIHBhcmFtZXRlciBpcyBpbnZhbGlkIG9yIGNhbm5vdCBiZSBwYXJzZWRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlRHVyYXRpb25Ub0RhdGUocGFyYW06IFN0cmluZ1ZhbHVlIHwgRGF0ZSB8IG51bWJlcik6IERhdGUge1xuICBpZiAodHlwZW9mIHBhcmFtID09PSAnc3RyaW5nJykge1xuICAgIGNvbnN0IGR1cmF0aW9uTXMgPSBtcyhwYXJhbSk7XG4gICAgaWYgKHR5cGVvZiBkdXJhdGlvbk1zICE9PSAnbnVtYmVyJyB8fCBkdXJhdGlvbk1zIDwgMCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgSW52YWxpZCBkdXJhdGlvbjogXCIke3BhcmFtfVwiLiBFeHBlY3RlZCBhIHZhbGlkIGR1cmF0aW9uIHN0cmluZyBsaWtlIFwiMXNcIiwgXCIxbVwiLCBcIjFoXCIsIGV0Yy5gXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gbmV3IERhdGUoRGF0ZS5ub3coKSArIGR1cmF0aW9uTXMpO1xuICB9IGVsc2UgaWYgKHR5cGVvZiBwYXJhbSA9PT0gJ251bWJlcicpIHtcbiAgICBpZiAocGFyYW0gPCAwIHx8ICFOdW1iZXIuaXNGaW5pdGUocGFyYW0pKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBJbnZhbGlkIGR1cmF0aW9uOiAke3BhcmFtfS4gRXhwZWN0ZWQgYSBub24tbmVnYXRpdmUgZmluaXRlIG51bWJlciBvZiBtaWxsaXNlY29uZHMuYFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIG5ldyBEYXRlKERhdGUubm93KCkgKyBwYXJhbSk7XG4gIH0gZWxzZSBpZiAoXG4gICAgcGFyYW0gaW5zdGFuY2VvZiBEYXRlIHx8XG4gICAgKHBhcmFtICYmXG4gICAgICB0eXBlb2YgcGFyYW0gPT09ICdvYmplY3QnICYmXG4gICAgICB0eXBlb2YgKHBhcmFtIGFzIGFueSkuZ2V0VGltZSA9PT0gJ2Z1bmN0aW9uJylcbiAgKSB7XG4gICAgLy8gSGFuZGxlIGJvdGggRGF0ZSBpbnN0YW5jZXMgYW5kIGRhdGUtbGlrZSBvYmplY3RzIChmcm9tIGRlc2VyaWFsaXphdGlvbilcbiAgICByZXR1cm4gcGFyYW0gaW5zdGFuY2VvZiBEYXRlID8gcGFyYW0gOiBuZXcgRGF0ZSgocGFyYW0gYXMgYW55KS5nZXRUaW1lKCkpO1xuICB9IGVsc2Uge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBJbnZhbGlkIGR1cmF0aW9uIHBhcmFtZXRlci4gRXhwZWN0ZWQgYSBkdXJhdGlvbiBzdHJpbmcsIG51bWJlciAobWlsbGlzZWNvbmRzKSwgb3IgRGF0ZSBvYmplY3QuYFxuICAgICk7XG4gIH1cbn1cbiIsICJpbXBvcnQgeyBwYXJzZUR1cmF0aW9uVG9EYXRlIH0gZnJvbSAnQHdvcmtmbG93L3V0aWxzJztcbmltcG9ydCB0eXBlIHsgU3RydWN0dXJlZEVycm9yIH0gZnJvbSAnQHdvcmtmbG93L3dvcmxkJztcbmltcG9ydCB0eXBlIHsgU3RyaW5nVmFsdWUgfSBmcm9tICdtcyc7XG5cbmNvbnN0IEJBU0VfVVJMID0gJ2h0dHBzOi8vdXNld29ya2Zsb3cuZGV2L2Vycic7XG5cbi8qKlxuICogQGludGVybmFsXG4gKiBDaGVjayBpZiBhIHZhbHVlIGlzIGFuIEVycm9yIHdpdGhvdXQgcmVseWluZyBvbiBOb2RlLmpzIHV0aWxpdGllcy5cbiAqIFRoaXMgaXMgbmVlZGVkIGZvciBlcnJvciBjbGFzc2VzIHRoYXQgY2FuIGJlIHVzZWQgaW4gVk0gY29udGV4dHMgd2hlcmVcbiAqIE5vZGUuanMgaW1wb3J0cyBhcmUgbm90IGF2YWlsYWJsZS5cbiAqL1xuZnVuY3Rpb24gaXNFcnJvcih2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIHsgbmFtZTogc3RyaW5nOyBtZXNzYWdlOiBzdHJpbmcgfSB7XG4gIHJldHVybiAoXG4gICAgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0JyAmJlxuICAgIHZhbHVlICE9PSBudWxsICYmXG4gICAgJ25hbWUnIGluIHZhbHVlICYmXG4gICAgJ21lc3NhZ2UnIGluIHZhbHVlXG4gICk7XG59XG5cbi8qKlxuICogQGludGVybmFsXG4gKiBBbGwgdGhlIHNsdWdzIG9mIHRoZSBlcnJvcnMgdXNlZCBmb3IgZG9jdW1lbnRhdGlvbiBsaW5rcy5cbiAqL1xuZXhwb3J0IGNvbnN0IEVSUk9SX1NMVUdTID0ge1xuICBOT0RFX0pTX01PRFVMRV9JTl9XT1JLRkxPVzogJ25vZGUtanMtbW9kdWxlLWluLXdvcmtmbG93JyxcbiAgU1RBUlRfSU5WQUxJRF9XT1JLRkxPV19GVU5DVElPTjogJ3N0YXJ0LWludmFsaWQtd29ya2Zsb3ctZnVuY3Rpb24nLFxuICBTRVJJQUxJWkFUSU9OX0ZBSUxFRDogJ3NlcmlhbGl6YXRpb24tZmFpbGVkJyxcbiAgV0VCSE9PS19JTlZBTElEX1JFU1BPTkRfV0lUSF9WQUxVRTogJ3dlYmhvb2staW52YWxpZC1yZXNwb25kLXdpdGgtdmFsdWUnLFxuICBXRUJIT09LX1JFU1BPTlNFX05PVF9TRU5UOiAnd2ViaG9vay1yZXNwb25zZS1ub3Qtc2VudCcsXG4gIEZFVENIX0lOX1dPUktGTE9XX0ZVTkNUSU9OOiAnZmV0Y2gtaW4td29ya2Zsb3cnLFxuICBUSU1FT1VUX0ZVTkNUSU9OU19JTl9XT1JLRkxPVzogJ3RpbWVvdXQtaW4td29ya2Zsb3cnLFxuICBIT09LX0NPTkZMSUNUOiAnaG9vay1jb25mbGljdCcsXG4gIENPUlJVUFRFRF9FVkVOVF9MT0c6ICdjb3JydXB0ZWQtZXZlbnQtbG9nJyxcbiAgUkVQTEFZX0RJVkVSR0VOQ0U6ICdyZXBsYXktZGl2ZXJnZW5jZScsXG4gIFNURVBfTk9UX1JFR0lTVEVSRUQ6ICdzdGVwLW5vdC1yZWdpc3RlcmVkJyxcbiAgV09SS0ZMT1dfTk9UX1JFR0lTVEVSRUQ6ICd3b3JrZmxvdy1ub3QtcmVnaXN0ZXJlZCcsXG4gIFJVTlRJTUVfREVDUllQVElPTl9GQUlMRUQ6ICdydW50aW1lLWRlY3J5cHRpb24tZmFpbGVkJyxcbn0gYXMgY29uc3Q7XG5cbnR5cGUgRXJyb3JTbHVnID0gKHR5cGVvZiBFUlJPUl9TTFVHUylba2V5b2YgdHlwZW9mIEVSUk9SX1NMVUdTXTtcblxuaW50ZXJmYWNlIFdvcmtmbG93RXJyb3JPcHRpb25zIGV4dGVuZHMgRXJyb3JPcHRpb25zIHtcbiAgLyoqXG4gICAqIFRoZSBzbHVnIG9mIHRoZSBlcnJvci4gVGhpcyB3aWxsIGJlIHVzZWQgdG8gZ2VuZXJhdGUgYSBsaW5rIHRvIHRoZSBlcnJvciBkb2N1bWVudGF0aW9uLlxuICAgKi9cbiAgc2x1Zz86IEVycm9yU2x1Zztcbn1cblxuLyoqXG4gKiBUaGUgYmFzZSBjbGFzcyBmb3IgYWxsIFdvcmtmbG93LXJlbGF0ZWQgZXJyb3JzLlxuICpcbiAqIFRoaXMgZXJyb3IgaXMgdGhyb3duIGJ5IHRoZSBXb3JrZmxvdyBTREsgd2hlbiBpbnRlcm5hbCBvcGVyYXRpb25zIGZhaWwuXG4gKiBZb3UgY2FuIHVzZSB0aGlzIGNsYXNzIHdpdGggYGluc3RhbmNlb2ZgIHRvIGNhdGNoIGFueSBXb3JrZmxvdyBTREsgZXJyb3IuXG4gKlxuICogQGV4YW1wbGVcbiAqIGBgYHRzXG4gKiB0cnkge1xuICogICBhd2FpdCBnZXRSdW4ocnVuSWQpO1xuICogfSBjYXRjaCAoZXJyb3IpIHtcbiAqICAgaWYgKGVycm9yIGluc3RhbmNlb2YgV29ya2Zsb3dFcnJvcikge1xuICogICAgIGNvbnNvbGUuZXJyb3IoJ1dvcmtmbG93IFNESyBlcnJvcjonLCBlcnJvci5tZXNzYWdlKTtcbiAqICAgfVxuICogfVxuICogYGBgXG4gKi9cbmV4cG9ydCBjbGFzcyBXb3JrZmxvd0Vycm9yIGV4dGVuZHMgRXJyb3Ige1xuICByZWFkb25seSBjYXVzZT86IHVua25vd247XG5cbiAgY29uc3RydWN0b3IobWVzc2FnZTogc3RyaW5nLCBvcHRpb25zPzogV29ya2Zsb3dFcnJvck9wdGlvbnMpIHtcbiAgICBjb25zdCBtc2dEb2NzID0gb3B0aW9ucz8uc2x1Z1xuICAgICAgPyBgJHttZXNzYWdlfVxcblxcbkxlYXJuIG1vcmU6ICR7QkFTRV9VUkx9LyR7b3B0aW9ucy5zbHVnfWBcbiAgICAgIDogbWVzc2FnZTtcbiAgICBzdXBlcihtc2dEb2NzLCB7IGNhdXNlOiBvcHRpb25zPy5jYXVzZSB9KTtcbiAgICB0aGlzLmNhdXNlID0gb3B0aW9ucz8uY2F1c2U7XG5cbiAgICBpZiAob3B0aW9ucz8uY2F1c2UgaW5zdGFuY2VvZiBFcnJvcikge1xuICAgICAgdGhpcy5zdGFjayA9IGAke3RoaXMuc3RhY2t9XFxuQ2F1c2VkIGJ5OiAke29wdGlvbnMuY2F1c2Uuc3RhY2t9YDtcbiAgICB9XG4gIH1cblxuICBzdGF0aWMgaXModmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBXb3JrZmxvd0Vycm9yIHtcbiAgICByZXR1cm4gaXNFcnJvcih2YWx1ZSkgJiYgdmFsdWUubmFtZSA9PT0gJ1dvcmtmbG93RXJyb3InO1xuICB9XG59XG5cbi8qKlxuICogVGhyb3duIHdoZW4gYSB3b3JsZCAoc3RvcmFnZSBiYWNrZW5kKSBvcGVyYXRpb24gZmFpbHMgdW5leHBlY3RlZGx5LlxuICpcbiAqIFRoaXMgaXMgdGhlIGNhdGNoLWFsbCBlcnJvciBmb3Igd29ybGQgaW1wbGVtZW50YXRpb25zLiBTcGVjaWZpYyxcbiAqIHdlbGwta25vd24gZmFpbHVyZSBtb2RlcyBoYXZlIGRlZGljYXRlZCBlcnJvciB0eXBlcyAoZS5nLlxuICogRW50aXR5Q29uZmxpY3RFcnJvciwgUnVuRXhwaXJlZEVycm9yLCBUaHJvdHRsZUVycm9yKS4gVGhpcyBlcnJvclxuICogY292ZXJzIGV2ZXJ5dGhpbmcgZWxzZSDigJQgdmFsaWRhdGlvbiBmYWlsdXJlcywgbWlzc2luZyBlbnRpdGllc1xuICogd2l0aG91dCBhIGRlZGljYXRlZCB0eXBlLCBvciB1bmV4cGVjdGVkIEhUVFAgZXJyb3JzIGZyb20gd29ybGQtdmVyY2VsLlxuICovXG5leHBvcnQgY2xhc3MgV29ya2Zsb3dXb3JsZEVycm9yIGV4dGVuZHMgV29ya2Zsb3dFcnJvciB7XG4gIHN0YXR1cz86IG51bWJlcjtcbiAgY29kZT86IHN0cmluZztcbiAgdXJsPzogc3RyaW5nO1xuICAvKiogUmV0cnktQWZ0ZXIgdmFsdWUgaW4gc2Vjb25kcywgcHJlc2VudCBvbiA0MjkgYW5kIDQyNSByZXNwb25zZXMgKi9cbiAgcmV0cnlBZnRlcj86IG51bWJlcjtcblxuICBjb25zdHJ1Y3RvcihcbiAgICBtZXNzYWdlOiBzdHJpbmcsXG4gICAgb3B0aW9ucz86IHtcbiAgICAgIHN0YXR1cz86IG51bWJlcjtcbiAgICAgIHVybD86IHN0cmluZztcbiAgICAgIGNvZGU/OiBzdHJpbmc7XG4gICAgICByZXRyeUFmdGVyPzogbnVtYmVyO1xuICAgICAgY2F1c2U/OiB1bmtub3duO1xuICAgIH1cbiAgKSB7XG4gICAgc3VwZXIobWVzc2FnZSwge1xuICAgICAgY2F1c2U6IG9wdGlvbnM/LmNhdXNlLFxuICAgIH0pO1xuICAgIHRoaXMubmFtZSA9ICdXb3JrZmxvd1dvcmxkRXJyb3InO1xuICAgIHRoaXMuc3RhdHVzID0gb3B0aW9ucz8uc3RhdHVzO1xuICAgIHRoaXMuY29kZSA9IG9wdGlvbnM/LmNvZGU7XG4gICAgdGhpcy51cmwgPSBvcHRpb25zPy51cmw7XG4gICAgdGhpcy5yZXRyeUFmdGVyID0gb3B0aW9ucz8ucmV0cnlBZnRlcjtcbiAgfVxuXG4gIHN0YXRpYyBpcyh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIFdvcmtmbG93V29ybGRFcnJvciB7XG4gICAgcmV0dXJuIGlzRXJyb3IodmFsdWUpICYmIHZhbHVlLm5hbWUgPT09ICdXb3JrZmxvd1dvcmxkRXJyb3InO1xuICB9XG59XG5cbi8qKlxuICogVGhyb3duIHdoZW4gYSB3b3JrZmxvdyBydW4gZmFpbHMgZHVyaW5nIGV4ZWN1dGlvbi5cbiAqXG4gKiBUaGlzIGVycm9yIGluZGljYXRlcyB0aGF0IHRoZSB3b3JrZmxvdyBlbmNvdW50ZXJlZCBhIGZhdGFsIGVycm9yIGFuZCBjYW5ub3RcbiAqIGNvbnRpbnVlLiBJdCBpcyB0aHJvd24gd2hlbiBhd2FpdGluZyBgcnVuLnJldHVyblZhbHVlYCBvbiBhIHJ1biB3aG9zZSBzdGF0dXNcbiAqIGlzIGAnZmFpbGVkJ2AuIFRoZSBgY2F1c2VgIHByb3BlcnR5IGNvbnRhaW5zIHRoZSB1bmRlcmx5aW5nIGVycm9yIHdpdGggaXRzXG4gKiBtZXNzYWdlLCBzdGFjayB0cmFjZSwgYW5kIG9wdGlvbmFsIGVycm9yIGNvZGUuXG4gKlxuICogVXNlIHRoZSBzdGF0aWMgYFdvcmtmbG93UnVuRmFpbGVkRXJyb3IuaXMoKWAgbWV0aG9kIGZvciB0eXBlLXNhZmUgY2hlY2tpbmdcbiAqIGluIGNhdGNoIGJsb2Nrcy5cbiAqXG4gKiBAZXhhbXBsZVxuICogYGBgdHNcbiAqIGltcG9ydCB7IFdvcmtmbG93UnVuRmFpbGVkRXJyb3IgfSBmcm9tIFwid29ya2Zsb3cvaW50ZXJuYWwvZXJyb3JzXCI7XG4gKlxuICogdHJ5IHtcbiAqICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuLnJldHVyblZhbHVlO1xuICogfSBjYXRjaCAoZXJyb3IpIHtcbiAqICAgaWYgKFdvcmtmbG93UnVuRmFpbGVkRXJyb3IuaXMoZXJyb3IpKSB7XG4gKiAgICAgY29uc29sZS5lcnJvcihgUnVuICR7ZXJyb3IucnVuSWR9IGZhaWxlZDpgLCBlcnJvci5jYXVzZS5tZXNzYWdlKTtcbiAqICAgfVxuICogfVxuICogYGBgXG4gKi9cbmV4cG9ydCBjbGFzcyBXb3JrZmxvd1J1bkZhaWxlZEVycm9yIGV4dGVuZHMgV29ya2Zsb3dFcnJvciB7XG4gIHJ1bklkOiBzdHJpbmc7XG4gIGRlY2xhcmUgY2F1c2U6IEVycm9yICYgeyBjb2RlPzogc3RyaW5nIH07XG5cbiAgY29uc3RydWN0b3IocnVuSWQ6IHN0cmluZywgZXJyb3I6IFN0cnVjdHVyZWRFcnJvcikge1xuICAgIC8vIENyZWF0ZSBhIHByb3BlciBFcnJvciBpbnN0YW5jZSBmcm9tIHRoZSBTdHJ1Y3R1cmVkRXJyb3IgdG8gc2V0IGFzIGNhdXNlXG4gICAgLy8gTk9URTogY3VzdG9tIGVycm9yIHR5cGVzIGRvIG5vdCBnZXQgc2VyaWFsaXplZC9kZXNlcmlhbGl6ZWQuIEV2ZXJ5dGhpbmcgaXMgYW4gRXJyb3JcbiAgICBjb25zdCBjYXVzZUVycm9yID0gbmV3IEVycm9yKGVycm9yLm1lc3NhZ2UpO1xuICAgIGlmIChlcnJvci5zdGFjaykge1xuICAgICAgY2F1c2VFcnJvci5zdGFjayA9IGVycm9yLnN0YWNrO1xuICAgIH1cbiAgICBpZiAoZXJyb3IuY29kZSkge1xuICAgICAgKGNhdXNlRXJyb3IgYXMgYW55KS5jb2RlID0gZXJyb3IuY29kZTtcbiAgICB9XG5cbiAgICBzdXBlcihgV29ya2Zsb3cgcnVuIFwiJHtydW5JZH1cIiBmYWlsZWQ6ICR7ZXJyb3IubWVzc2FnZX1gLCB7XG4gICAgICBjYXVzZTogY2F1c2VFcnJvcixcbiAgICB9KTtcbiAgICB0aGlzLm5hbWUgPSAnV29ya2Zsb3dSdW5GYWlsZWRFcnJvcic7XG4gICAgdGhpcy5ydW5JZCA9IHJ1bklkO1xuICB9XG5cbiAgc3RhdGljIGlzKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgV29ya2Zsb3dSdW5GYWlsZWRFcnJvciB7XG4gICAgcmV0dXJuIGlzRXJyb3IodmFsdWUpICYmIHZhbHVlLm5hbWUgPT09ICdXb3JrZmxvd1J1bkZhaWxlZEVycm9yJztcbiAgfVxufVxuXG4vKipcbiAqIFRocm93biB3aGVuIGF0dGVtcHRpbmcgdG8gZ2V0IHJlc3VsdHMgZnJvbSBhbiBpbmNvbXBsZXRlIHdvcmtmbG93IHJ1bi5cbiAqXG4gKiBUaGlzIGVycm9yIG9jY3VycyB3aGVuIHlvdSB0cnkgdG8gYWNjZXNzIHRoZSByZXN1bHQgb2YgYSB3b3JrZmxvd1xuICogdGhhdCBpcyBzdGlsbCBydW5uaW5nIG9yIGhhc24ndCBjb21wbGV0ZWQgeWV0LlxuICovXG5leHBvcnQgY2xhc3MgV29ya2Zsb3dSdW5Ob3RDb21wbGV0ZWRFcnJvciBleHRlbmRzIFdvcmtmbG93RXJyb3Ige1xuICBydW5JZDogc3RyaW5nO1xuICBzdGF0dXM6IHN0cmluZztcblxuICBjb25zdHJ1Y3RvcihydW5JZDogc3RyaW5nLCBzdGF0dXM6IHN0cmluZykge1xuICAgIHN1cGVyKGBXb3JrZmxvdyBydW4gXCIke3J1bklkfVwiIGhhcyBub3QgY29tcGxldGVkYCwge30pO1xuICAgIHRoaXMubmFtZSA9ICdXb3JrZmxvd1J1bk5vdENvbXBsZXRlZEVycm9yJztcbiAgICB0aGlzLnJ1bklkID0gcnVuSWQ7XG4gICAgdGhpcy5zdGF0dXMgPSBzdGF0dXM7XG4gIH1cblxuICBzdGF0aWMgaXModmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBXb3JrZmxvd1J1bk5vdENvbXBsZXRlZEVycm9yIHtcbiAgICByZXR1cm4gaXNFcnJvcih2YWx1ZSkgJiYgdmFsdWUubmFtZSA9PT0gJ1dvcmtmbG93UnVuTm90Q29tcGxldGVkRXJyb3InO1xuICB9XG59XG5cbi8qKlxuICogVGhyb3duIHdoZW4gdGhlIFdvcmtmbG93IHJ1bnRpbWUgZW5jb3VudGVycyBhbiBpbnRlcm5hbCBlcnJvci5cbiAqXG4gKiBUaGlzIGVycm9yIGluZGljYXRlcyBhbiBpc3N1ZSB3aXRoIHdvcmtmbG93IGV4ZWN1dGlvbiwgc3VjaCBhc1xuICogc2VyaWFsaXphdGlvbiBmYWlsdXJlcywgc3RhcnRpbmcgYW4gaW52YWxpZCB3b3JrZmxvdyBmdW5jdGlvbiwgb3JcbiAqIG90aGVyIHJ1bnRpbWUgcHJvYmxlbXMuXG4gKi9cbmV4cG9ydCBjbGFzcyBXb3JrZmxvd1J1bnRpbWVFcnJvciBleHRlbmRzIFdvcmtmbG93RXJyb3Ige1xuICBjb25zdHJ1Y3RvcihtZXNzYWdlOiBzdHJpbmcsIG9wdGlvbnM/OiBXb3JrZmxvd0Vycm9yT3B0aW9ucykge1xuICAgIHN1cGVyKG1lc3NhZ2UsIHtcbiAgICAgIC4uLm9wdGlvbnMsXG4gICAgfSk7XG4gICAgdGhpcy5uYW1lID0gJ1dvcmtmbG93UnVudGltZUVycm9yJztcbiAgfVxuXG4gIHN0YXRpYyBpcyh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIFdvcmtmbG93UnVudGltZUVycm9yIHtcbiAgICByZXR1cm4gaXNFcnJvcih2YWx1ZSkgJiYgdmFsdWUubmFtZSA9PT0gJ1dvcmtmbG93UnVudGltZUVycm9yJztcbiAgfVxufVxuXG4vKipcbiAqIFRocm93biB3aGVuIHRoZSBwZXJzaXN0ZWQgd29ya2Zsb3cgZXZlbnQgbG9nIGNhbm5vdCBiZSByZXBsYXllZCBiZWNhdXNlIGl0XG4gKiBjb250YWlucyBvcnBoYW5lZCwgZHVwbGljYXRlLCBvciBtaXNtYXRjaGVkIGV2ZW50cy5cbiAqXG4gKiBUaGlzIGlzIGEgcnVudGltZS9pbmZyYXN0cnVjdHVyZSBmYWlsdXJlIHJhdGhlciB0aGFuIHVzZXIgY29kZSB0aHJvd2luZy5cbiAqIFdoZW4gdGhpcyByZWFjaGVzIHJ1biBmYWlsdXJlIGhhbmRsaW5nLCBpdCBpcyByZWNvcmRlZCB3aXRoIHRoZSBkaXN0aW5jdFxuICogYENPUlJVUFRFRF9FVkVOVF9MT0dgIGNvZGUgc28gd29ybGRzIGFuZCBiYWNrZW5kcyBjYW4gdHJhY2sgaXQgc2VwYXJhdGVseVxuICogZnJvbSBnZW5lcmljIHJ1bnRpbWUgZmFpbHVyZXMuXG4gKi9cbmV4cG9ydCBjbGFzcyBDb3JydXB0ZWRFdmVudExvZ0Vycm9yIGV4dGVuZHMgV29ya2Zsb3dSdW50aW1lRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihtZXNzYWdlOiBzdHJpbmcsIG9wdGlvbnM/OiBFcnJvck9wdGlvbnMpIHtcbiAgICBzdXBlcihtZXNzYWdlLCB7XG4gICAgICAuLi5vcHRpb25zLFxuICAgICAgc2x1ZzogRVJST1JfU0xVR1MuQ09SUlVQVEVEX0VWRU5UX0xPRyxcbiAgICB9KTtcbiAgICB0aGlzLm5hbWUgPSAnQ29ycnVwdGVkRXZlbnRMb2dFcnJvcic7XG4gIH1cblxuICBzdGF0aWMgaXModmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBDb3JydXB0ZWRFdmVudExvZ0Vycm9yIHtcbiAgICByZXR1cm4gaXNFcnJvcih2YWx1ZSkgJiYgdmFsdWUubmFtZSA9PT0gJ0NvcnJ1cHRlZEV2ZW50TG9nRXJyb3InO1xuICB9XG59XG5cbi8qKlxuICogVGhyb3duIHdoZW4gYSBydW4ncyBldmVudCBsb2cgcmVhY2hlcyB0aGUgc2VydmVyLXN1cHBsaWVkIHBlci1ydW4gZXZlbnRcbiAqIGNlaWxpbmcuIENsYXNzaWZpZWQgYXMgYE1BWF9FVkVOVFNfRVhDRUVERURgIChzZWUgYGNsYXNzaWZ5UnVuRXJyb3JgKS5cbiAqL1xuZXhwb3J0IGNsYXNzIE1heEV2ZW50c0V4Y2VlZGVkRXJyb3IgZXh0ZW5kcyBXb3JrZmxvd0Vycm9yIHtcbiAgcmVhZG9ubHkgZXZlbnRDb3VudDogbnVtYmVyO1xuICByZWFkb25seSBsaW1pdDogbnVtYmVyO1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIGV2ZW50Q291bnQ6IG51bWJlcixcbiAgICBsaW1pdDogbnVtYmVyLFxuICAgIG9wdGlvbnM/OiBXb3JrZmxvd0Vycm9yT3B0aW9uc1xuICApIHtcbiAgICBzdXBlcihgV29ya2Zsb3cgZXhjZWVkZWQgdGhlIG1heGltdW0gb2YgJHtsaW1pdH0gZXZlbnRzIHBlciBydW5gLCBvcHRpb25zKTtcbiAgICB0aGlzLm5hbWUgPSAnTWF4RXZlbnRzRXhjZWVkZWRFcnJvcic7XG4gICAgdGhpcy5ldmVudENvdW50ID0gZXZlbnRDb3VudDtcbiAgICB0aGlzLmxpbWl0ID0gbGltaXQ7XG4gIH1cblxuICBzdGF0aWMgaXModmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBNYXhFdmVudHNFeGNlZWRlZEVycm9yIHtcbiAgICByZXR1cm4gaXNFcnJvcih2YWx1ZSkgJiYgdmFsdWUubmFtZSA9PT0gJ01heEV2ZW50c0V4Y2VlZGVkRXJyb3InO1xuICB9XG59XG5cbi8qKlxuICogT3B0aW9uYWwgc3RydWN0dXJlZCBjb250ZXh0IGF0dGFjaGVkIHRvIGEge0BsaW5rIFJ1bnRpbWVEZWNyeXB0aW9uRXJyb3J9LFxuICogY2FycmllZCBvdmVyIGZyb20gdGhlIHVuZGVybHlpbmcgZGVjcnlwdCBjYWxsIHNpdGUgdG8gaGVscCBkaWFnbm9zZSB0aGVcbiAqIGZhaWx1cmUgd2l0aG91dCBwb2tpbmcgdGhyb3VnaCBzdGFja3MuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUnVudGltZURlY3J5cHRpb25FcnJvckNvbnRleHQge1xuICAvKiogVGhlIG9wZXJhdGlvbiB0aGF0IGZhaWxlZCDigJQgdXNlZnVsIHRvIHRlbGwgZW5jcnlwdCB2cyBkZWNyeXB0IGFwYXJ0LiAqL1xuICBvcGVyYXRpb24/OiAnZW5jcnlwdCcgfCAnZGVjcnlwdCc7XG4gIC8qKiBCeXRlIGxlbmd0aCBvZiB0aGUgaW5wdXQgcGF5bG9hZCBhdCB0aGUgdGltZSBvZiB0aGUgZmFpbHVyZS4gKi9cbiAgYnl0ZUxlbmd0aD86IG51bWJlcjtcbiAgLyoqXG4gICAqIFRoZSBmaXJzdCA0IGJ5dGVzIG9mIHRoZSBpbnB1dCBwYXlsb2FkLCBkZWNvZGVkIGFzIFVURi04IGlmIHByaW50YWJsZS5cbiAgICogVXNlZnVsIGZvciB0ZWxsaW5nIGFwYXJ0IHRydW5jYXRlZC1idXQtdmFsaWQtbG9va2luZyBlbmNyeXB0ZWQgcGF5bG9hZHNcbiAgICogZnJvbSBjb21wbGV0ZWx5IHVucmVsYXRlZCBjb3JydXB0aW9uIChlLmcuIGFuIEhUTUwgZXJyb3IgcGFnZSBzdXJmYWNlZFxuICAgKiBhcyBhIDIwMCBPSykuXG4gICAqL1xuICBmb3JtYXRQcmVmaXg/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogVGhyb3duIHdoZW4gdGhlIFNESydzIGJ1aWx0LWluIEFFUy1HQ00gZW5jcnlwdGlvbiBsYXllciBmYWlscyB0byBlbmNyeXB0XG4gKiBvciBkZWNyeXB0IGEgd29ya2Zsb3cgcGF5bG9hZC5cbiAqXG4gKiBUaGlzIGlzIGFuIGludGVybmFsIFNESyBmYWlsdXJlIOKAlCB1c2VyIGNvZGUgbmV2ZXIgaW52b2tlcyB0aGUgU0RLJ3NcbiAqIGVuY3J5cHRpb24gcHJpbWl0aXZlcyBkaXJlY3RseS4gQ29tbW9uIGNhdXNlczpcbiAqXG4gKiAtIEEgY2lwaGVydGV4dCAvIGF1dGggdGFnIG1pc21hdGNoLCB0eXBpY2FsbHkgc3VyZmFjZWQgYXMgdGhlIG5hdGl2ZSBXZWJcbiAqICAgQ3J5cHRvIGBPcGVyYXRpb25FcnJvcjogVGhlIG9wZXJhdGlvbiBmYWlsZWQgZm9yIGFuIG9wZXJhdGlvbi1zcGVjaWZpY1xuICogICByZWFzb25gLiBVc3VhbGx5IGNhdXNlZCBieSBjaXBoZXJ0ZXh0IG11dGF0aW9uIG9yIHRydW5jYXRpb24gaW4gdHJhbnNpdFxuICogICBiZXR3ZWVuIHN0b3JhZ2UgYW5kIHJlYWQgKHRydW5jYXRlZCBIVFRQIHJlc3BvbnNlLCBlZGdlLWNhY2hlIG1pc3NcbiAqICAgcmV0dXJuaW5nIGEgcGFydGlhbCAyMDAsIHByb3h5IGRyb3AgZHVyaW5nIHN0cmVhbWluZywgZXRjLikuXG4gKiAtIEEga2V5IHJlc29sdXRpb24gbWlzbWF0Y2ggKHdyb25nIGRlcGxveW1lbnQsIG1pc3Npbmcga2V5IG1hdGVyaWFsKS5cbiAqIC0gQSBtYWxmb3JtZWQgZW5jcnlwdGVkIGVudmVsb3BlICh0b28gc2hvcnQgdG8gY29udGFpbiB0aGUgR0NNIG5vbmNlXG4gKiAgIGFuZCB0YWcpLlxuICpcbiAqIEV4dGVuZHMge0BsaW5rIFdvcmtmbG93UnVudGltZUVycm9yfSBzbyB0aGUgcnVuLWZhaWx1cmUgY2xhc3NpZmllclxuICogcm91dGVzIGl0IHRvIGBSVU5USU1FX0VSUk9SYC5cbiAqL1xuZXhwb3J0IGNsYXNzIFJ1bnRpbWVEZWNyeXB0aW9uRXJyb3IgZXh0ZW5kcyBXb3JrZmxvd1J1bnRpbWVFcnJvciB7XG4gIC8qKiBPcHRpb25hbCBzdHJ1Y3R1cmVkIGNvbnRleHQgYWJvdXQgdGhlIGZhaWxlZCBlbmNyeXB0L2RlY3J5cHQgY2FsbC4gKi9cbiAgZGVjbGFyZSByZWFkb25seSBjb250ZXh0PzogUnVudGltZURlY3J5cHRpb25FcnJvckNvbnRleHQ7XG5cbiAgY29uc3RydWN0b3IoXG4gICAgbWVzc2FnZTogc3RyaW5nLFxuICAgIG9wdGlvbnM/OiBFcnJvck9wdGlvbnMgJiB7IGNvbnRleHQ/OiBSdW50aW1lRGVjcnlwdGlvbkVycm9yQ29udGV4dCB9XG4gICkge1xuICAgIHN1cGVyKG1lc3NhZ2UsIHtcbiAgICAgIGNhdXNlOiBvcHRpb25zPy5jYXVzZSxcbiAgICAgIHNsdWc6IEVSUk9SX1NMVUdTLlJVTlRJTUVfREVDUllQVElPTl9GQUlMRUQsXG4gICAgfSk7XG4gICAgdGhpcy5uYW1lID0gJ1J1bnRpbWVEZWNyeXB0aW9uRXJyb3InO1xuICAgIGlmIChvcHRpb25zPy5jb250ZXh0ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRoaXMuY29udGV4dCA9IG9wdGlvbnMuY29udGV4dDtcbiAgICB9XG4gIH1cblxuICBzdGF0aWMgaXModmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBSdW50aW1lRGVjcnlwdGlvbkVycm9yIHtcbiAgICByZXR1cm4gaXNFcnJvcih2YWx1ZSkgJiYgdmFsdWUubmFtZSA9PT0gJ1J1bnRpbWVEZWNyeXB0aW9uRXJyb3InO1xuICB9XG59XG5cbi8qKlxuICogVGhyb3duIHdoZW4gdGhlIGN1cnJlbnQgd29ya2Zsb3cgcmVwbGF5IGNhbm5vdCBmb2xsb3cgdGhlIHBhdGggZGVzY3JpYmVkIGJ5XG4gKiB0aGUgcmVjb3JkZWQgZXZlbnQgbG9nLiBBIHNpbmdsZSBkaXZlcmdlbmNlIGRvZXMgbm90IHByb3ZlIHRoYXQgdGhlXG4gKiBwZXJzaXN0ZWQgaGlzdG9yeSBpcyBpbnZhbGlkOiBhIHN1YnNlcXVlbnQgcmVwbGF5IG1heSBvYnNlcnZlIG9yIHNjaGVkdWxlXG4gKiB3b3JrIGNvcnJlY3RseSwgc28gdGhlIHJ1bnRpbWUgbWF5IHJlZGVsaXZlciBiZWZvcmUgZGVjbGFyaW5nIGNvcnJ1cHRpb24uXG4gKi9cbmV4cG9ydCBjbGFzcyBSZXBsYXlEaXZlcmdlbmNlRXJyb3IgZXh0ZW5kcyBXb3JrZmxvd1J1bnRpbWVFcnJvciB7XG4gIHJlYWRvbmx5IGV2ZW50SWQ6IHN0cmluZztcblxuICBjb25zdHJ1Y3RvcihtZXNzYWdlOiBzdHJpbmcsIG9wdGlvbnM6IEVycm9yT3B0aW9ucyAmIHsgZXZlbnRJZDogc3RyaW5nIH0pIHtcbiAgICBzdXBlcihtZXNzYWdlLCB7XG4gICAgICAuLi5vcHRpb25zLFxuICAgICAgc2x1ZzogRVJST1JfU0xVR1MuUkVQTEFZX0RJVkVSR0VOQ0UsXG4gICAgfSk7XG4gICAgdGhpcy5uYW1lID0gJ1JlcGxheURpdmVyZ2VuY2VFcnJvcic7XG4gICAgdGhpcy5ldmVudElkID0gb3B0aW9ucy5ldmVudElkO1xuICB9XG5cbiAgc3RhdGljIGlzKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgUmVwbGF5RGl2ZXJnZW5jZUVycm9yIHtcbiAgICByZXR1cm4gaXNFcnJvcih2YWx1ZSkgJiYgdmFsdWUubmFtZSA9PT0gJ1JlcGxheURpdmVyZ2VuY2VFcnJvcic7XG4gIH1cbn1cblxuLyoqXG4gKiBUaHJvd24gd2hlbiBhIHN0ZXAgZnVuY3Rpb24gaXMgbm90IHJlZ2lzdGVyZWQgaW4gdGhlIGN1cnJlbnQgZGVwbG95bWVudC5cbiAqXG4gKiBUaGlzIGlzIGFuIGluZnJhc3RydWN0dXJlIGVycm9yIOKAlCBub3QgYSB1c2VyIGNvZGUgZXJyb3IuIEl0IHR5cGljYWxseSBtZWFuc1xuICogc29tZXRoaW5nIHdlbnQgd3Jvbmcgd2l0aCB0aGUgYnVuZGxpbmcvYnVpbGQgdG9vbGluZyB0aGF0IGNhdXNlZCB0aGUgc3RlcFxuICogdG8gbm90IGdldCBidWlsdCBjb3JyZWN0bHkuXG4gKlxuICogV2hlbiB0aGlzIGhhcHBlbnMsIHRoZSBzdGVwIGZhaWxzIChsaWtlIGEgRmF0YWxFcnJvcikgYW5kIGNvbnRyb2wgaXMgcGFzc2VkIGJhY2tcbiAqIHRvIHRoZSB3b3JrZmxvdyBmdW5jdGlvbiwgd2hpY2ggY2FuIG9wdGlvbmFsbHkgaGFuZGxlIHRoZSBmYWlsdXJlIGdyYWNlZnVsbHkuXG4gKi9cbmV4cG9ydCBjbGFzcyBTdGVwTm90UmVnaXN0ZXJlZEVycm9yIGV4dGVuZHMgV29ya2Zsb3dSdW50aW1lRXJyb3Ige1xuICBzdGVwTmFtZTogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKHN0ZXBOYW1lOiBzdHJpbmcpIHtcbiAgICBzdXBlcihcbiAgICAgIGBTdGVwIFwiJHtzdGVwTmFtZX1cIiBpcyBub3QgcmVnaXN0ZXJlZCBpbiB0aGUgY3VycmVudCBkZXBsb3ltZW50LiBUaGlzIHVzdWFsbHkgaW5kaWNhdGVzIGEgYnVpbGQgb3IgYnVuZGxpbmcgaXNzdWUgdGhhdCBjYXVzZWQgdGhlIHN0ZXAgdG8gbm90IGJlIGluY2x1ZGVkIGluIHRoZSBkZXBsb3ltZW50LmAsXG4gICAgICB7IHNsdWc6IEVSUk9SX1NMVUdTLlNURVBfTk9UX1JFR0lTVEVSRUQgfVxuICAgICk7XG4gICAgdGhpcy5uYW1lID0gJ1N0ZXBOb3RSZWdpc3RlcmVkRXJyb3InO1xuICAgIHRoaXMuc3RlcE5hbWUgPSBzdGVwTmFtZTtcbiAgfVxuXG4gIHN0YXRpYyBpcyh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIFN0ZXBOb3RSZWdpc3RlcmVkRXJyb3Ige1xuICAgIHJldHVybiBpc0Vycm9yKHZhbHVlKSAmJiB2YWx1ZS5uYW1lID09PSAnU3RlcE5vdFJlZ2lzdGVyZWRFcnJvcic7XG4gIH1cbn1cblxuLyoqXG4gKiBUaHJvd24gd2hlbiBhIHdvcmtmbG93IGZ1bmN0aW9uIGlzIG5vdCByZWdpc3RlcmVkIGluIHRoZSBjdXJyZW50IGRlcGxveW1lbnQuXG4gKlxuICogVGhpcyBpcyBhbiBpbmZyYXN0cnVjdHVyZSBlcnJvciDigJQgbm90IGEgdXNlciBjb2RlIGVycm9yLiBJdCB0eXBpY2FsbHkgbWVhbnM6XG4gKiAtIEEgcnVuIHdhcyBzdGFydGVkIGFnYWluc3QgYSBkZXBsb3ltZW50IHRoYXQgZG9lcyBub3QgaGF2ZSB0aGUgd29ya2Zsb3dcbiAqICAgKGUuZy4sIHRoZSB3b3JrZmxvdyB3YXMgcmVuYW1lZCBvciBtb3ZlZCBhbmQgYSBuZXcgcnVuIHRhcmdldGVkIHRoZSBsYXRlc3QgZGVwbG95bWVudClcbiAqIC0gU29tZXRoaW5nIHdlbnQgd3Jvbmcgd2l0aCB0aGUgYnVuZGxpbmcvYnVpbGQgdG9vbGluZyB0aGF0IGNhdXNlZCB0aGUgd29ya2Zsb3dcbiAqICAgdG8gbm90IGdldCBidWlsdCBjb3JyZWN0bHlcbiAqXG4gKiBXaGVuIHRoaXMgaGFwcGVucywgdGhlIHJ1biBmYWlscyB3aXRoIGEgYFJVTlRJTUVfRVJST1JgIGVycm9yIGNvZGUuXG4gKi9cbmV4cG9ydCBjbGFzcyBXb3JrZmxvd05vdFJlZ2lzdGVyZWRFcnJvciBleHRlbmRzIFdvcmtmbG93UnVudGltZUVycm9yIHtcbiAgd29ya2Zsb3dOYW1lOiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3Iod29ya2Zsb3dOYW1lOiBzdHJpbmcpIHtcbiAgICBzdXBlcihcbiAgICAgIGBXb3JrZmxvdyBcIiR7d29ya2Zsb3dOYW1lfVwiIGlzIG5vdCByZWdpc3RlcmVkIGluIHRoZSBjdXJyZW50IGRlcGxveW1lbnQuIFRoaXMgdXN1YWxseSBtZWFucyBhIHJ1biB3YXMgc3RhcnRlZCBhZ2FpbnN0IGEgZGVwbG95bWVudCB0aGF0IGRvZXMgbm90IGhhdmUgdGhpcyB3b3JrZmxvdywgb3IgdGhlcmUgd2FzIGEgYnVpbGQvYnVuZGxpbmcgaXNzdWUuYCxcbiAgICAgIHsgc2x1ZzogRVJST1JfU0xVR1MuV09SS0ZMT1dfTk9UX1JFR0lTVEVSRUQgfVxuICAgICk7XG4gICAgdGhpcy5uYW1lID0gJ1dvcmtmbG93Tm90UmVnaXN0ZXJlZEVycm9yJztcbiAgICB0aGlzLndvcmtmbG93TmFtZSA9IHdvcmtmbG93TmFtZTtcbiAgfVxuXG4gIHN0YXRpYyBpcyh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIFdvcmtmbG93Tm90UmVnaXN0ZXJlZEVycm9yIHtcbiAgICByZXR1cm4gaXNFcnJvcih2YWx1ZSkgJiYgdmFsdWUubmFtZSA9PT0gJ1dvcmtmbG93Tm90UmVnaXN0ZXJlZEVycm9yJztcbiAgfVxufVxuXG4vKipcbiAqIFRocm93biB3aGVuIHBlcmZvcm1pbmcgb3BlcmF0aW9ucyBvbiBhIHdvcmtmbG93IHJ1biB0aGF0IGRvZXMgbm90IGV4aXN0LlxuICpcbiAqIFRoaXMgZXJyb3Igb2NjdXJzIHdoZW4geW91IGNhbGwgbWV0aG9kcyBvbiBhIHJ1biBvYmplY3QgKGUuZy4gYHJ1bi5zdGF0dXNgLFxuICogYHJ1bi5jYW5jZWwoKWAsIGBydW4ucmV0dXJuVmFsdWVgKSBidXQgdGhlIHVuZGVybHlpbmcgcnVuIElEIGRvZXMgbm90IG1hdGNoXG4gKiBhbnkga25vd24gd29ya2Zsb3cgcnVuLiBOb3RlIHRoYXQgYGdldFJ1bihpZClgIGl0c2VsZiBpcyBzeW5jaHJvbm91cyBhbmQgd2lsbFxuICogbm90IHRocm93IOKAlCB0aGlzIGVycm9yIGlzIHJhaXNlZCB3aGVuIHN1YnNlcXVlbnQgb3BlcmF0aW9ucyBkaXNjb3ZlciB0aGUgcnVuXG4gKiBpcyBtaXNzaW5nLlxuICpcbiAqIFVzZSB0aGUgc3RhdGljIGBXb3JrZmxvd1J1bk5vdEZvdW5kRXJyb3IuaXMoKWAgbWV0aG9kIGZvciB0eXBlLXNhZmUgY2hlY2tpbmdcbiAqIGluIGNhdGNoIGJsb2Nrcy5cbiAqXG4gKiBAZXhhbXBsZVxuICogYGBgdHNcbiAqIGltcG9ydCB7IFdvcmtmbG93UnVuTm90Rm91bmRFcnJvciB9IGZyb20gXCJ3b3JrZmxvdy9pbnRlcm5hbC9lcnJvcnNcIjtcbiAqXG4gKiB0cnkge1xuICogICBjb25zdCBzdGF0dXMgPSBhd2FpdCBydW4uc3RhdHVzO1xuICogfSBjYXRjaCAoZXJyb3IpIHtcbiAqICAgaWYgKFdvcmtmbG93UnVuTm90Rm91bmRFcnJvci5pcyhlcnJvcikpIHtcbiAqICAgICBjb25zb2xlLmVycm9yKGBSdW4gJHtlcnJvci5ydW5JZH0gZG9lcyBub3QgZXhpc3RgKTtcbiAqICAgfVxuICogfVxuICogYGBgXG4gKi9cbmV4cG9ydCBjbGFzcyBXb3JrZmxvd1J1bk5vdEZvdW5kRXJyb3IgZXh0ZW5kcyBXb3JrZmxvd0Vycm9yIHtcbiAgcnVuSWQ6IHN0cmluZztcblxuICBjb25zdHJ1Y3RvcihydW5JZDogc3RyaW5nKSB7XG4gICAgc3VwZXIoYFdvcmtmbG93IHJ1biBcIiR7cnVuSWR9XCIgbm90IGZvdW5kYCwge30pO1xuICAgIHRoaXMubmFtZSA9ICdXb3JrZmxvd1J1bk5vdEZvdW5kRXJyb3InO1xuICAgIHRoaXMucnVuSWQgPSBydW5JZDtcbiAgfVxuXG4gIHN0YXRpYyBpcyh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIFdvcmtmbG93UnVuTm90Rm91bmRFcnJvciB7XG4gICAgcmV0dXJuIGlzRXJyb3IodmFsdWUpICYmIHZhbHVlLm5hbWUgPT09ICdXb3JrZmxvd1J1bk5vdEZvdW5kRXJyb3InO1xuICB9XG59XG5cbi8qKlxuICogVGhyb3duIHdoZW4gYSBob29rIHRva2VuIGlzIGFscmVhZHkgaW4gdXNlIGJ5IGFub3RoZXIgYWN0aXZlIHdvcmtmbG93IHJ1bi5cbiAqXG4gKiBUaGlzIGlzIGEgdXNlciBlcnJvciDigJQgaXQgbWVhbnMgdGhlIHNhbWUgY3VzdG9tIHRva2VuIHdhcyBwYXNzZWQgdG9cbiAqIGBjcmVhdGVIb29rYCBpbiB0d28gb3IgbW9yZSBjb25jdXJyZW50IHJ1bnMuIFVzZSBhIHVuaXF1ZSB0b2tlbiBwZXIgcnVuXG4gKiAob3Igb21pdCB0aGUgdG9rZW4gdG8gbGV0IHRoZSBydW50aW1lIGdlbmVyYXRlIG9uZSBhdXRvbWF0aWNhbGx5KS5cbiAqL1xuZXhwb3J0IGNsYXNzIEhvb2tDb25mbGljdEVycm9yIGV4dGVuZHMgV29ya2Zsb3dFcnJvciB7XG4gIHRva2VuOiBzdHJpbmc7XG4gIC8vIFRPRE86IE1ha2UgdGhpcyByZXF1aXJlZCBvbmNlIGFsbCBwZXJzaXN0ZWQgaG9va19jb25mbGljdCBldmVudHMgYW5kIFdvcmxkXG4gIC8vIGltcGxlbWVudGF0aW9ucyBhbHdheXMgaW5jbHVkZSB0aGUgYWN0aXZlIGhvb2sgb3duZXIncyBydW4gSUQuXG4gIGNvbmZsaWN0aW5nUnVuSWQ/OiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3IodG9rZW46IHN0cmluZywgY29uZmxpY3RpbmdSdW5JZD86IHN0cmluZykge1xuICAgIHN1cGVyKFxuICAgICAgYEhvb2sgdG9rZW4gXCIke3Rva2VufVwiIGlzIGFscmVhZHkgaW4gdXNlIGJ5IGFub3RoZXIgd29ya2Zsb3cke2NvbmZsaWN0aW5nUnVuSWQgPyBgIChydW4gXCIke2NvbmZsaWN0aW5nUnVuSWR9XCIpYCA6ICcnfWAsXG4gICAgICB7XG4gICAgICAgIHNsdWc6IEVSUk9SX1NMVUdTLkhPT0tfQ09ORkxJQ1QsXG4gICAgICB9XG4gICAgKTtcbiAgICB0aGlzLm5hbWUgPSAnSG9va0NvbmZsaWN0RXJyb3InO1xuICAgIHRoaXMudG9rZW4gPSB0b2tlbjtcbiAgICBpZiAoY29uZmxpY3RpbmdSdW5JZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aGlzLmNvbmZsaWN0aW5nUnVuSWQgPSBjb25mbGljdGluZ1J1bklkO1xuICAgIH1cbiAgfVxuXG4gIHN0YXRpYyBpcyh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIEhvb2tDb25mbGljdEVycm9yIHtcbiAgICByZXR1cm4gaXNFcnJvcih2YWx1ZSkgJiYgdmFsdWUubmFtZSA9PT0gJ0hvb2tDb25mbGljdEVycm9yJztcbiAgfVxufVxuXG4vKipcbiAqIFRocm93biB3aGVuIGNhbGxpbmcgYHJlc3VtZUhvb2soKWAgb3IgYHJlc3VtZVdlYmhvb2soKWAgd2l0aCBhIHRva2VuIHRoYXRcbiAqIGRvZXMgbm90IG1hdGNoIGFueSBhY3RpdmUgaG9vay5cbiAqXG4gKiBDb21tb24gY2F1c2VzOlxuICogLSBUaGUgaG9vayBoYXMgZXhwaXJlZCAocGFzdCBpdHMgVFRMKVxuICogLSBUaGUgaG9vayB3YXMgYWxyZWFkeSBkaXNwb3NlZCBhZnRlciBiZWluZyBjb25zdW1lZFxuICogLSBUaGUgd29ya2Zsb3cgaGFzIG5vdCBzdGFydGVkIHlldCwgc28gdGhlIGhvb2sgZG9lcyBub3QgZXhpc3RcbiAqXG4gKiBBIGNvbW1vbiBwYXR0ZXJuIGlzIHRvIGNhdGNoIHRoaXMgZXJyb3IgYW5kIHN0YXJ0IGEgbmV3IHdvcmtmbG93IHJ1biB3aGVuXG4gKiB0aGUgaG9vayBkb2VzIG5vdCBleGlzdCB5ZXQgKHRoZSBcInJlc3VtZSBvciBzdGFydFwiIHBhdHRlcm4pLlxuICpcbiAqIFVzZSB0aGUgc3RhdGljIGBIb29rTm90Rm91bmRFcnJvci5pcygpYCBtZXRob2QgZm9yIHR5cGUtc2FmZSBjaGVja2luZyBpblxuICogY2F0Y2ggYmxvY2tzLlxuICpcbiAqIEBleGFtcGxlXG4gKiBgYGB0c1xuICogaW1wb3J0IHsgSG9va05vdEZvdW5kRXJyb3IgfSBmcm9tIFwid29ya2Zsb3cvaW50ZXJuYWwvZXJyb3JzXCI7XG4gKlxuICogdHJ5IHtcbiAqICAgYXdhaXQgcmVzdW1lSG9vayh0b2tlbiwgcGF5bG9hZCk7XG4gKiB9IGNhdGNoIChlcnJvcikge1xuICogICBpZiAoSG9va05vdEZvdW5kRXJyb3IuaXMoZXJyb3IpKSB7XG4gKiAgICAgLy8gSG9vayBkb2Vzbid0IGV4aXN0IOKAlCBzdGFydCBhIG5ldyB3b3JrZmxvdyBydW4gaW5zdGVhZFxuICogICAgIGF3YWl0IHN0YXJ0V29ya2Zsb3coXCJteVdvcmtmbG93XCIsIHBheWxvYWQpO1xuICogICB9XG4gKiB9XG4gKiBgYGBcbiAqL1xuZXhwb3J0IGNsYXNzIEhvb2tOb3RGb3VuZEVycm9yIGV4dGVuZHMgV29ya2Zsb3dFcnJvciB7XG4gIHRva2VuOiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3IodG9rZW46IHN0cmluZykge1xuICAgIHN1cGVyKCdIb29rIG5vdCBmb3VuZCcsIHt9KTtcbiAgICB0aGlzLm5hbWUgPSAnSG9va05vdEZvdW5kRXJyb3InO1xuICAgIHRoaXMudG9rZW4gPSB0b2tlbjtcbiAgfVxuXG4gIHN0YXRpYyBpcyh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIEhvb2tOb3RGb3VuZEVycm9yIHtcbiAgICByZXR1cm4gaXNFcnJvcih2YWx1ZSkgJiYgdmFsdWUubmFtZSA9PT0gJ0hvb2tOb3RGb3VuZEVycm9yJztcbiAgfVxufVxuXG4vKipcbiAqIFRocm93biB3aGVuIGFuIG9wZXJhdGlvbiBjb25mbGljdHMgd2l0aCB0aGUgY3VycmVudCBzdGF0ZSBvZiBhbiBlbnRpdHkuXG4gKiBUaGlzIGluY2x1ZGVzIGF0dGVtcHRzIHRvIG1vZGlmeSBhbiBlbnRpdHkgYWxyZWFkeSBpbiBhIHRlcm1pbmFsIHN0YXRlLFxuICogY3JlYXRlIGFuIGVudGl0eSB0aGF0IGFscmVhZHkgZXhpc3RzLCBvciBhbnkgb3RoZXIgNDA5LXN0eWxlIGNvbmZsaWN0LlxuICpcbiAqIFRoZSB3b3JrZmxvdyBydW50aW1lIGhhbmRsZXMgdGhpcyBlcnJvciBhdXRvbWF0aWNhbGx5LiBVc2VycyBpbnRlcmFjdGluZ1xuICogd2l0aCB3b3JsZCBzdG9yYWdlIGJhY2tlbmRzIGRpcmVjdGx5IG1heSBlbmNvdW50ZXIgaXQuXG4gKi9cbmV4cG9ydCBjbGFzcyBFbnRpdHlDb25mbGljdEVycm9yIGV4dGVuZHMgV29ya2Zsb3dXb3JsZEVycm9yIHtcbiAgY29uc3RydWN0b3IobWVzc2FnZTogc3RyaW5nKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gJ0VudGl0eUNvbmZsaWN0RXJyb3InO1xuICB9XG5cbiAgc3RhdGljIGlzKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgRW50aXR5Q29uZmxpY3RFcnJvciB7XG4gICAgcmV0dXJuIGlzRXJyb3IodmFsdWUpICYmIHZhbHVlLm5hbWUgPT09ICdFbnRpdHlDb25mbGljdEVycm9yJztcbiAgfVxufVxuXG4vKipcbiAqIFRocm93biB3aGVuIGEgcnVuIGlzIG5vIGxvbmdlciBhdmFpbGFibGUg4oCUIGVpdGhlciBiZWNhdXNlIGl0IGhhcyBiZWVuXG4gKiBjbGVhbmVkIHVwLCBleHBpcmVkLCBvciBhbHJlYWR5IHJlYWNoZWQgYSB0ZXJtaW5hbCBzdGF0ZSAoY29tcGxldGVkL2ZhaWxlZCkuXG4gKlxuICogVGhlIHdvcmtmbG93IHJ1bnRpbWUgaGFuZGxlcyB0aGlzIGVycm9yIGF1dG9tYXRpY2FsbHkuIFVzZXJzIGludGVyYWN0aW5nXG4gKiB3aXRoIHdvcmxkIHN0b3JhZ2UgYmFja2VuZHMgZGlyZWN0bHkgbWF5IGVuY291bnRlciBpdC5cbiAqL1xuZXhwb3J0IGNsYXNzIFJ1bkV4cGlyZWRFcnJvciBleHRlbmRzIFdvcmtmbG93V29ybGRFcnJvciB7XG4gIGNvbnN0cnVjdG9yKG1lc3NhZ2U6IHN0cmluZykge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9ICdSdW5FeHBpcmVkRXJyb3InO1xuICB9XG5cbiAgc3RhdGljIGlzKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgUnVuRXhwaXJlZEVycm9yIHtcbiAgICByZXR1cm4gaXNFcnJvcih2YWx1ZSkgJiYgdmFsdWUubmFtZSA9PT0gJ1J1bkV4cGlyZWRFcnJvcic7XG4gIH1cbn1cblxuLyoqXG4gKiBUaHJvd24gd2hlbiBhbiBvcGVyYXRpb24gY2Fubm90IHByb2NlZWQgYmVjYXVzZSBhIHJlcXVpcmVkIHRpbWVzdGFtcFxuICogKGUuZy4gcmV0cnlBZnRlcikgaGFzIG5vdCBiZWVuIHJlYWNoZWQgeWV0LlxuICpcbiAqIFRoZSB3b3JrZmxvdyBydW50aW1lIGhhbmRsZXMgdGhpcyBlcnJvciBhdXRvbWF0aWNhbGx5LiBVc2VycyBpbnRlcmFjdGluZ1xuICogd2l0aCB3b3JsZCBzdG9yYWdlIGJhY2tlbmRzIGRpcmVjdGx5IG1heSBlbmNvdW50ZXIgaXQuXG4gKlxuICogQHByb3BlcnR5IHJldHJ5QWZ0ZXIgLSBEZWxheSBpbiBzZWNvbmRzIGJlZm9yZSB0aGUgb3BlcmF0aW9uIGNhbiBiZSByZXRyaWVkLlxuICovXG5leHBvcnQgY2xhc3MgVG9vRWFybHlFcnJvciBleHRlbmRzIFdvcmtmbG93V29ybGRFcnJvciB7XG4gIGNvbnN0cnVjdG9yKG1lc3NhZ2U6IHN0cmluZywgb3B0aW9ucz86IHsgcmV0cnlBZnRlcj86IG51bWJlciB9KSB7XG4gICAgc3VwZXIobWVzc2FnZSwgeyByZXRyeUFmdGVyOiBvcHRpb25zPy5yZXRyeUFmdGVyIH0pO1xuICAgIHRoaXMubmFtZSA9ICdUb29FYXJseUVycm9yJztcbiAgfVxuXG4gIHN0YXRpYyBpcyh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIFRvb0Vhcmx5RXJyb3Ige1xuICAgIHJldHVybiBpc0Vycm9yKHZhbHVlKSAmJiB2YWx1ZS5uYW1lID09PSAnVG9vRWFybHlFcnJvcic7XG4gIH1cbn1cblxuLyoqXG4gKiBUaHJvd24gd2hlbiBhIHJlcXVlc3QgaXMgcmF0ZSBsaW1pdGVkIGJ5IHRoZSB3b3JrZmxvdyBiYWNrZW5kLlxuICpcbiAqIFRoZSB3b3JrZmxvdyBydW50aW1lIGhhbmRsZXMgdGhpcyBlcnJvciBhdXRvbWF0aWNhbGx5IHdpdGggcmV0cnkgbG9naWMuXG4gKiBVc2VycyBpbnRlcmFjdGluZyB3aXRoIHdvcmxkIHN0b3JhZ2UgYmFja2VuZHMgZGlyZWN0bHkgbWF5IGVuY291bnRlciBpdFxuICogaWYgcmV0cmllcyBhcmUgZXhoYXVzdGVkLlxuICpcbiAqIEBwcm9wZXJ0eSByZXRyeUFmdGVyIC0gRGVsYXkgaW4gc2Vjb25kcyBiZWZvcmUgdGhlIHJlcXVlc3QgY2FuIGJlIHJldHJpZWQuXG4gKi9cbmV4cG9ydCBjbGFzcyBUaHJvdHRsZUVycm9yIGV4dGVuZHMgV29ya2Zsb3dXb3JsZEVycm9yIHtcbiAgcmV0cnlBZnRlcj86IG51bWJlcjtcblxuICBjb25zdHJ1Y3RvcihtZXNzYWdlOiBzdHJpbmcsIG9wdGlvbnM/OiB7IHJldHJ5QWZ0ZXI/OiBudW1iZXIgfSkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9ICdUaHJvdHRsZUVycm9yJztcbiAgICB0aGlzLnJldHJ5QWZ0ZXIgPSBvcHRpb25zPy5yZXRyeUFmdGVyO1xuICB9XG5cbiAgc3RhdGljIGlzKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgVGhyb3R0bGVFcnJvciB7XG4gICAgcmV0dXJuIGlzRXJyb3IodmFsdWUpICYmIHZhbHVlLm5hbWUgPT09ICdUaHJvdHRsZUVycm9yJztcbiAgfVxufVxuXG4vKipcbiAqIFRocm93biB3aGVuIHRoZSBiYWNrZW5kIHJlamVjdHMgYW4gZXZlbnQgY3JlYXRpb24gYmVjYXVzZSB0aGUgY2xpZW50J3NcbiAqIGV2ZW50LWxvZyBzbmFwc2hvdCBpcyBzdGFsZSDigJQgYSBuZXdlciBvdXQtb2YtYmFuZCBldmVudCAoZS5nLiBhIHJlY2VpdmVkXG4gKiBob29rIG9yIGEgY29tcGxldGVkIHN0ZXApIHdhcyByZWNvcmRlZCBhZnRlciB0aGUgc25hcHNob3QgdGhlIGNsaWVudFxuICogcmVwbGF5ZWQgZnJvbSAoSFRUUCA0MTIpLlxuICpcbiAqIFRoZSB3b3JrZmxvdyBydW50aW1lIGhhbmRsZXMgdGhpcyBhdXRvbWF0aWNhbGx5OiBpdCByZWxvYWRzIHRoZSBldmVudCBsb2dcbiAqIGFuZCByZXRyaWVzLCB1bHRpbWF0ZWx5IHJlLWVucXVldWVpbmcgdGhlIHJ1biBpZiBpdCBjYW5ub3QgY2F0Y2ggdXAuIFVzZXJzXG4gKiBpbnRlcmFjdGluZyB3aXRoIHdvcmxkIHN0b3JhZ2UgYmFja2VuZHMgZGlyZWN0bHkgbWF5IGVuY291bnRlciBpdC5cbiAqL1xuZXhwb3J0IGNsYXNzIFByZWNvbmRpdGlvbkZhaWxlZEVycm9yIGV4dGVuZHMgV29ya2Zsb3dXb3JsZEVycm9yIHtcbiAgY29uc3RydWN0b3IobWVzc2FnZTogc3RyaW5nLCBvcHRpb25zPzogeyByZXRyeUFmdGVyPzogbnVtYmVyIH0pIHtcbiAgICBzdXBlcihtZXNzYWdlLCB7IHN0YXR1czogNDEyLCByZXRyeUFmdGVyOiBvcHRpb25zPy5yZXRyeUFmdGVyIH0pO1xuICAgIHRoaXMubmFtZSA9ICdQcmVjb25kaXRpb25GYWlsZWRFcnJvcic7XG4gIH1cblxuICBzdGF0aWMgaXModmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBQcmVjb25kaXRpb25GYWlsZWRFcnJvciB7XG4gICAgcmV0dXJuIGlzRXJyb3IodmFsdWUpICYmIHZhbHVlLm5hbWUgPT09ICdQcmVjb25kaXRpb25GYWlsZWRFcnJvcic7XG4gIH1cbn1cblxuLyoqXG4gKiBUaHJvd24gd2hlbiBhd2FpdGluZyBgcnVuLnJldHVyblZhbHVlYCBvbiBhIHdvcmtmbG93IHJ1biB0aGF0IHdhcyBjYW5jZWxsZWQuXG4gKlxuICogVGhpcyBlcnJvciBpbmRpY2F0ZXMgdGhhdCB0aGUgd29ya2Zsb3cgd2FzIGV4cGxpY2l0bHkgY2FuY2VsbGVkICh2aWFcbiAqIGBydW4uY2FuY2VsKClgKSBhbmQgd2lsbCBub3QgcHJvZHVjZSBhIHJldHVybiB2YWx1ZS4gWW91IGNhbiBjaGVjayBmb3JcbiAqIGNhbmNlbGxhdGlvbiBiZWZvcmUgYXdhaXRpbmcgdGhlIHJldHVybiB2YWx1ZSBieSBpbnNwZWN0aW5nIGBydW4uc3RhdHVzYC5cbiAqXG4gKiBVc2UgdGhlIHN0YXRpYyBgV29ya2Zsb3dSdW5DYW5jZWxsZWRFcnJvci5pcygpYCBtZXRob2QgZm9yIHR5cGUtc2FmZVxuICogY2hlY2tpbmcgaW4gY2F0Y2ggYmxvY2tzLlxuICpcbiAqIEBleGFtcGxlXG4gKiBgYGB0c1xuICogaW1wb3J0IHsgV29ya2Zsb3dSdW5DYW5jZWxsZWRFcnJvciB9IGZyb20gXCJ3b3JrZmxvdy9pbnRlcm5hbC9lcnJvcnNcIjtcbiAqXG4gKiB0cnkge1xuICogICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW4ucmV0dXJuVmFsdWU7XG4gKiB9IGNhdGNoIChlcnJvcikge1xuICogICBpZiAoV29ya2Zsb3dSdW5DYW5jZWxsZWRFcnJvci5pcyhlcnJvcikpIHtcbiAqICAgICBjb25zb2xlLmxvZyhgUnVuICR7ZXJyb3IucnVuSWR9IHdhcyBjYW5jZWxsZWRgKTtcbiAqICAgfVxuICogfVxuICogYGBgXG4gKi9cbmV4cG9ydCBjbGFzcyBXb3JrZmxvd1J1bkNhbmNlbGxlZEVycm9yIGV4dGVuZHMgV29ya2Zsb3dFcnJvciB7XG4gIHJ1bklkOiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3IocnVuSWQ6IHN0cmluZykge1xuICAgIHN1cGVyKGBXb3JrZmxvdyBydW4gXCIke3J1bklkfVwiIGNhbmNlbGxlZGAsIHt9KTtcbiAgICB0aGlzLm5hbWUgPSAnV29ya2Zsb3dSdW5DYW5jZWxsZWRFcnJvcic7XG4gICAgdGhpcy5ydW5JZCA9IHJ1bklkO1xuICB9XG5cbiAgc3RhdGljIGlzKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgV29ya2Zsb3dSdW5DYW5jZWxsZWRFcnJvciB7XG4gICAgcmV0dXJuIGlzRXJyb3IodmFsdWUpICYmIHZhbHVlLm5hbWUgPT09ICdXb3JrZmxvd1J1bkNhbmNlbGxlZEVycm9yJztcbiAgfVxufVxuXG4vKipcbiAqIFRocm93biB3aGVuIGF0dGVtcHRpbmcgdG8gb3BlcmF0ZSBvbiBhIHdvcmtmbG93IHJ1biB0aGF0IHJlcXVpcmVzIGEgbmV3ZXIgV29ybGQgdmVyc2lvbi5cbiAqXG4gKiBUaGlzIGVycm9yIG9jY3VycyB3aGVuIGEgcnVuIHdhcyBjcmVhdGVkIHdpdGggYSBuZXdlciBzcGVjIHZlcnNpb24gdGhhbiB0aGVcbiAqIGN1cnJlbnQgV29ybGQgaW1wbGVtZW50YXRpb24gc3VwcG9ydHMuIFRvIHJlc29sdmUgdGhpcywgdXBncmFkZSB5b3VyXG4gKiBgd29ya2Zsb3dgIHBhY2thZ2VzIHRvIGEgdmVyc2lvbiB0aGF0IHN1cHBvcnRzIHRoZSByZXF1aXJlZCBzcGVjIHZlcnNpb24uXG4gKlxuICogVXNlIHRoZSBzdGF0aWMgYFJ1bk5vdFN1cHBvcnRlZEVycm9yLmlzKClgIG1ldGhvZCBmb3IgdHlwZS1zYWZlIGNoZWNraW5nIGluXG4gKiBjYXRjaCBibG9ja3MuXG4gKlxuICogQGV4YW1wbGVcbiAqIGBgYHRzXG4gKiBpbXBvcnQgeyBSdW5Ob3RTdXBwb3J0ZWRFcnJvciB9IGZyb20gXCJ3b3JrZmxvdy9pbnRlcm5hbC9lcnJvcnNcIjtcbiAqXG4gKiB0cnkge1xuICogICBjb25zdCBzdGF0dXMgPSBhd2FpdCBydW4uc3RhdHVzO1xuICogfSBjYXRjaCAoZXJyb3IpIHtcbiAqICAgaWYgKFJ1bk5vdFN1cHBvcnRlZEVycm9yLmlzKGVycm9yKSkge1xuICogICAgIGNvbnNvbGUuZXJyb3IoXG4gKiAgICAgICBgUnVuIHJlcXVpcmVzIHNwZWMgdiR7ZXJyb3IucnVuU3BlY1ZlcnNpb259LCBgICtcbiAqICAgICAgIGBidXQgd29ybGQgc3VwcG9ydHMgdiR7ZXJyb3Iud29ybGRTcGVjVmVyc2lvbn1gXG4gKiAgICAgKTtcbiAqICAgfVxuICogfVxuICogYGBgXG4gKi9cbmV4cG9ydCBjbGFzcyBSdW5Ob3RTdXBwb3J0ZWRFcnJvciBleHRlbmRzIFdvcmtmbG93RXJyb3Ige1xuICByZWFkb25seSBydW5TcGVjVmVyc2lvbjogbnVtYmVyO1xuICByZWFkb25seSB3b3JsZFNwZWNWZXJzaW9uOiBudW1iZXI7XG5cbiAgY29uc3RydWN0b3IocnVuU3BlY1ZlcnNpb246IG51bWJlciwgd29ybGRTcGVjVmVyc2lvbjogbnVtYmVyKSB7XG4gICAgc3VwZXIoXG4gICAgICBgUnVuIHJlcXVpcmVzIHNwZWMgdmVyc2lvbiAke3J1blNwZWNWZXJzaW9ufSwgYnV0IHdvcmxkIHN1cHBvcnRzIHZlcnNpb24gJHt3b3JsZFNwZWNWZXJzaW9ufS4gYCArXG4gICAgICAgIGBQbGVhc2UgdXBncmFkZSAnd29ya2Zsb3cnIHBhY2thZ2UuYFxuICAgICk7XG4gICAgdGhpcy5uYW1lID0gJ1J1bk5vdFN1cHBvcnRlZEVycm9yJztcbiAgICB0aGlzLnJ1blNwZWNWZXJzaW9uID0gcnVuU3BlY1ZlcnNpb247XG4gICAgdGhpcy53b3JsZFNwZWNWZXJzaW9uID0gd29ybGRTcGVjVmVyc2lvbjtcbiAgfVxuXG4gIHN0YXRpYyBpcyh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIFJ1bk5vdFN1cHBvcnRlZEVycm9yIHtcbiAgICByZXR1cm4gaXNFcnJvcih2YWx1ZSkgJiYgdmFsdWUubmFtZSA9PT0gJ1J1bk5vdFN1cHBvcnRlZEVycm9yJztcbiAgfVxufVxuXG4vKipcbiAqIEEgZmF0YWwgZXJyb3IgaXMgYW4gZXJyb3IgdGhhdCBjYW5ub3QgYmUgcmV0cmllZC5cbiAqIEl0IHdpbGwgY2F1c2UgdGhlIHN0ZXAgdG8gZmFpbCBhbmQgdGhlIGVycm9yIHdpbGxcbiAqIGJlIGJ1YmJsZWQgdXAgdG8gdGhlIHdvcmtmbG93IGxvZ2ljLlxuICovXG5leHBvcnQgY2xhc3MgRmF0YWxFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgZmF0YWwgPSB0cnVlO1xuXG4gIGNvbnN0cnVjdG9yKG1lc3NhZ2U6IHN0cmluZykge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9ICdGYXRhbEVycm9yJztcbiAgfVxuXG4gIHN0YXRpYyBpcyh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIEZhdGFsRXJyb3Ige1xuICAgIHJldHVybiBpc0Vycm9yKHZhbHVlKSAmJiB2YWx1ZS5uYW1lID09PSAnRmF0YWxFcnJvcic7XG4gIH1cbn1cblxuZXhwb3J0IGludGVyZmFjZSBSZXRyeWFibGVFcnJvck9wdGlvbnMge1xuICAvKipcbiAgICogVGhlIG51bWJlciBvZiBtaWxsaXNlY29uZHMgdG8gd2FpdCBiZWZvcmUgcmV0cnlpbmcgdGhlIHN0ZXAuXG4gICAqIENhbiBhbHNvIGJlIGEgZHVyYXRpb24gc3RyaW5nIChlLmcuLCBcIjVzXCIsIFwiMm1cIikgb3IgYSBEYXRlIG9iamVjdC5cbiAgICogSWYgbm90IHByb3ZpZGVkLCB0aGUgc3RlcCB3aWxsIGJlIHJldHJpZWQgYWZ0ZXIgMSBzZWNvbmQgKDEwMDAgbWlsbGlzZWNvbmRzKS5cbiAgICovXG4gIHJldHJ5QWZ0ZXI/OiBudW1iZXIgfCBTdHJpbmdWYWx1ZSB8IERhdGU7XG59XG5cbi8qKlxuICogQW4gZXJyb3IgdGhhdCBjYW4gaGFwcGVuIGR1cmluZyBhIHN0ZXAgZXhlY3V0aW9uLCBhbGxvd2luZ1xuICogZm9yIGNvbmZpZ3VyYXRpb24gb2YgdGhlIHJldHJ5IGJlaGF2aW9yLlxuICovXG5leHBvcnQgY2xhc3MgUmV0cnlhYmxlRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIC8qKlxuICAgKiBUaGUgRGF0ZSB3aGVuIHRoZSBzdGVwIHNob3VsZCBiZSByZXRyaWVkLlxuICAgKi9cbiAgcmV0cnlBZnRlcjogRGF0ZTtcblxuICBjb25zdHJ1Y3RvcihtZXNzYWdlOiBzdHJpbmcsIG9wdGlvbnM6IFJldHJ5YWJsZUVycm9yT3B0aW9ucyA9IHt9KSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gJ1JldHJ5YWJsZUVycm9yJztcblxuICAgIGlmIChvcHRpb25zLnJldHJ5QWZ0ZXIgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhpcy5yZXRyeUFmdGVyID0gcGFyc2VEdXJhdGlvblRvRGF0ZShvcHRpb25zLnJldHJ5QWZ0ZXIpO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBEZWZhdWx0IHRvIDEgc2Vjb25kICgxMDAwIG1pbGxpc2Vjb25kcylcbiAgICAgIHRoaXMucmV0cnlBZnRlciA9IG5ldyBEYXRlKERhdGUubm93KCkgKyAxMDAwKTtcbiAgICB9XG4gIH1cblxuICBzdGF0aWMgaXModmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBSZXRyeWFibGVFcnJvciB7XG4gICAgcmV0dXJuIGlzRXJyb3IodmFsdWUpICYmIHZhbHVlLm5hbWUgPT09ICdSZXRyeWFibGVFcnJvcic7XG4gIH1cbn1cblxuZXhwb3J0IGNvbnN0IFZFUkNFTF80MDNfRVJST1JfTUVTU0FHRSA9XG4gICdZb3VyIGN1cnJlbnQgdmVyY2VsIGFjY291bnQgZG9lcyBub3QgaGF2ZSBhY2Nlc3MgdG8gdGhpcyByZXNvdXJjZS4gVXNlIGB2ZXJjZWwgbG9naW5gIG9yIGB2ZXJjZWwgc3dpdGNoYCB0byBlbnN1cmUgeW91IGFyZSBsaW5rZWQgdG8gdGhlIHJpZ2h0IGFjY291bnQuJztcblxuZXhwb3J0IHsgUlVOX0VSUk9SX0NPREVTLCB0eXBlIFJ1bkVycm9yQ29kZSB9IGZyb20gJy4vZXJyb3ItY29kZXMuanMnO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIENyb3NzLXJlYWxtIGNsYXNzIHJlZ2lzdHJhdGlvblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vL1xuLy8gYEZhdGFsRXJyb3JgLCBgUmV0cnlhYmxlRXJyb3JgLCBhbmQgYEhvb2tDb25mbGljdEVycm9yYCBhcmUgbm90IGJ1aWx0LWlucywgc28gZGlmZmVyZW50IHJlYWxtc1xuLy8gKGUuZy4gdGhlIHdvcmtmbG93IFZNIGNvbnRleHQgdnMuIHRoZSBob3N0IGNvbnRleHQgdGhhdCBydW5zIHRoZSBxdWV1ZVxuLy8gaGFuZGxlcikgYnVuZGxlIGFuZCBsb2FkIHRoZWlyIG93biBjb3BpZXMgb2YgdGhpcyBtb2R1bGUg4oCUIG1lYW5pbmcgZWFjaFxuLy8gcmVhbG0gaGFzIGl0cyBvd24gZGlzdGluY3QgY2xhc3MgaWRlbnRpdHkuIENyb3NzLXJlYWxtIGBpbnN0YW5jZW9mYCBmYWlsc1xuLy8gYmVjYXVzZSB0aGUgcHJvdG90eXBlIGNoYWlucyBuZXZlciBtZWV0LlxuLy9cbi8vIFRvIGxldCBzZXJpYWxpemF0aW9uIHJldml2ZXJzIHJlY29uc3RydWN0IGEgdmFsdWUgYXMgdGhlICpjb25zdW1lcidzKlxuLy8gRmF0YWxFcnJvciAoc28gdXNlci1jb2RlIGBlcnIgaW5zdGFuY2VvZiBGYXRhbEVycm9yYCBwYXNzZXMpLCBlYWNoIGJ1bmRsZWRcbi8vIGNvcHkgb2YgdGhpcyBtb2R1bGUgc2VsZi1yZWdpc3RlcnMgaXRzIGNsYXNzIG9uIGBnbG9iYWxUaGlzYCB2aWEgYSBrbm93blxuLy8gU3ltYm9sLmZvciBrZXkuIFJldml2ZXJzIGluIGBAd29ya2Zsb3cvY29yZWAgbG9vayB1cCB0aGUgY2xhc3MgdmlhIHRoZVxuLy8gY29uc3VtZXIncyBnbG9iYWxUaGlzIGF0IGh5ZHJhdGlvbiB0aW1lLlxuLy9cbi8vIEZpcnN0IHJlZ2lzdHJhdGlvbiBpbiBhIGdpdmVuIHJlYWxtIHdpbnMuIFRoZSBkZXNjcmlwdG9yIGlzIG5vbi13cml0YWJsZVxuLy8gYW5kIG5vbi1jb25maWd1cmFibGUgdG8gbWFrZSBhY2NpZGVudGFsIGNsb2JiZXJpbmcgbG91ZC5cbmNvbnN0IEZBVEFMX0VSUk9SX0tFWSA9IFN5bWJvbC5mb3IoJ0B3b3JrZmxvdy9lcnJvcnMvL0ZhdGFsRXJyb3InKTtcbmNvbnN0IFJFVFJZQUJMRV9FUlJPUl9LRVkgPSBTeW1ib2wuZm9yKCdAd29ya2Zsb3cvZXJyb3JzLy9SZXRyeWFibGVFcnJvcicpO1xuY29uc3QgSE9PS19DT05GTElDVF9FUlJPUl9LRVkgPSBTeW1ib2wuZm9yKFxuICAnQHdvcmtmbG93L2Vycm9ycy8vSG9va0NvbmZsaWN0RXJyb3InXG4pO1xuXG5pZiAodHlwZW9mIGdsb2JhbFRoaXMgIT09ICd1bmRlZmluZWQnKSB7XG4gIGlmICghT2JqZWN0Lmhhc093bihnbG9iYWxUaGlzLCBGQVRBTF9FUlJPUl9LRVkpKSB7XG4gICAgT2JqZWN0LmRlZmluZVByb3BlcnR5KGdsb2JhbFRoaXMsIEZBVEFMX0VSUk9SX0tFWSwge1xuICAgICAgdmFsdWU6IEZhdGFsRXJyb3IsXG4gICAgICB3cml0YWJsZTogZmFsc2UsXG4gICAgICBlbnVtZXJhYmxlOiBmYWxzZSxcbiAgICAgIGNvbmZpZ3VyYWJsZTogZmFsc2UsXG4gICAgfSk7XG4gIH1cbiAgaWYgKCFPYmplY3QuaGFzT3duKGdsb2JhbFRoaXMsIFJFVFJZQUJMRV9FUlJPUl9LRVkpKSB7XG4gICAgT2JqZWN0LmRlZmluZVByb3BlcnR5KGdsb2JhbFRoaXMsIFJFVFJZQUJMRV9FUlJPUl9LRVksIHtcbiAgICAgIHZhbHVlOiBSZXRyeWFibGVFcnJvcixcbiAgICAgIHdyaXRhYmxlOiBmYWxzZSxcbiAgICAgIGVudW1lcmFibGU6IGZhbHNlLFxuICAgICAgY29uZmlndXJhYmxlOiBmYWxzZSxcbiAgICB9KTtcbiAgfVxuICBpZiAoIU9iamVjdC5oYXNPd24oZ2xvYmFsVGhpcywgSE9PS19DT05GTElDVF9FUlJPUl9LRVkpKSB7XG4gICAgT2JqZWN0LmRlZmluZVByb3BlcnR5KGdsb2JhbFRoaXMsIEhPT0tfQ09ORkxJQ1RfRVJST1JfS0VZLCB7XG4gICAgICB2YWx1ZTogSG9va0NvbmZsaWN0RXJyb3IsXG4gICAgICB3cml0YWJsZTogZmFsc2UsXG4gICAgICBlbnVtZXJhYmxlOiBmYWxzZSxcbiAgICAgIGNvbmZpZ3VyYWJsZTogZmFsc2UsXG4gICAgfSk7XG4gIH1cbn1cbiIsICJleHBvcnQgY29uc3QgV09SS0ZMT1dfVVNFX1NURVAgPSBTeW1ib2wuZm9yKCdXT1JLRkxPV19VU0VfU1RFUCcpO1xuZXhwb3J0IGNvbnN0IFdPUktGTE9XX0NSRUFURV9IT09LID0gU3ltYm9sLmZvcignV09SS0ZMT1dfQ1JFQVRFX0hPT0snKTtcbmV4cG9ydCBjb25zdCBXT1JLRkxPV19TTEVFUCA9IFN5bWJvbC5mb3IoJ1dPUktGTE9XX1NMRUVQJyk7XG5leHBvcnQgY29uc3QgV09SS0ZMT1dfQ09OVEVYVCA9IFN5bWJvbC5mb3IoJ1dPUktGTE9XX0NPTlRFWFQnKTtcbmV4cG9ydCBjb25zdCBXT1JLRkxPV19HRVRfU1RSRUFNX0lEID0gU3ltYm9sLmZvcignV09SS0ZMT1dfR0VUX1NUUkVBTV9JRCcpO1xuZXhwb3J0IGNvbnN0IFNUQUJMRV9VTElEID0gU3ltYm9sLmZvcignV09SS0ZMT1dfU1RBQkxFX1VMSUQnKTtcbmV4cG9ydCBjb25zdCBTVFJFQU1fTkFNRV9TWU1CT0wgPSBTeW1ib2wuZm9yKCdXT1JLRkxPV19TVFJFQU1fTkFNRScpO1xuZXhwb3J0IGNvbnN0IFNUUkVBTV9UWVBFX1NZTUJPTCA9IFN5bWJvbC5mb3IoJ1dPUktGTE9XX1NUUkVBTV9UWVBFJyk7XG5leHBvcnQgY29uc3QgU1RSRUFNX0ZSQU1JTkdfU1lNQk9MID0gU3ltYm9sLmZvcignV09SS0ZMT1dfU1RSRUFNX0ZSQU1JTkcnKTtcbi8qKlxuICogU3RhbXBlZCBvbiBhIHJlYWwgYFdyaXRhYmxlU3RyZWFtYCAodGhlIHVzZXItdmlzaWJsZSBgc2VyaWFsaXplLndyaXRhYmxlYFxuICogcmV0dXJuZWQgZnJvbSBhIHN0ZXAtc2lkZSByZXZpdmVyIG9yIHN0ZXAtY29udGV4dCBgZ2V0V3JpdGFibGUoKWApIHRvXG4gKiByZWNvcmQgdGhlIGBydW5JZGAgb2YgdGhlIHdvcmtmbG93IHJ1biB0aGF0IG93bnMgdGhlIHVuZGVybHlpbmcgc2VydmVyXG4gKiBzdHJlYW0uIFVzZWQgdG9nZXRoZXIgd2l0aCBgU1RSRUFNX05BTUVfU1lNQk9MYC5cbiAqXG4gKiBXaGVuIGBnZXRFeHRlcm5hbFJlZHVjZXJzLldyaXRhYmxlU3RyZWFtYCAodGhlIGRlaHlkcmF0aW9uIHBhdGggdXNlZCBieVxuICogYHN0YXJ0KClgKSBzZWVzIGJvdGggc3ltYm9scyBvbiBhIHdyaXRhYmxlLCBpdCBpbmNsdWRlcyB0aGUgYHJ1bklkYCBpblxuICogdGhlIGRlc2NyaXB0b3IgaXQgZW1pdHMuIFRoZSBjaGlsZCBydW4ncyBzdGVwLXNpZGUgcmV2aXZlciB0aGVuIG9wZW5zXG4gKiBhIHNlcnZlciB3cml0YWJsZSBhZ2FpbnN0IHRoZSBvcmlnaW5hbCBgKHJ1bklkLCBuYW1lKWAgYW5kIHJlc29sdmVzXG4gKiB0aGF0IHJ1bidzIGVuY3J5cHRpb24ga2V5IGRpcmVjdGx5IOKAlCBzbyB0aGUgY2hpbGQncyB3cml0ZXMgbGFuZCBvblxuICogdGhlIHBhcmVudCdzIHN0cmVhbSBhcy1pcywgd2l0aCBubyBjbGllbnQgcHJvY2VzcyBpbiB0aGUgbG9vcC4gVGhhdFxuICoga2VlcHMgdGhlIGZvcndhcmRpbmcgYWxpdmUgZm9yIHRoZSBmdWxsIGxpZmV0aW1lIG9mIHRoZSBjaGlsZCBydW4sXG4gKiBub3QganVzdCBmb3IgdGhlIHBhcmVudCBzdGVwIHRoYXQgaW5pdGlhdGVkIGBzdGFydCgpYC5cbiAqL1xuZXhwb3J0IGNvbnN0IFNUUkVBTV9TRVJWRVJfUlVOX0lEX1NZTUJPTCA9IFN5bWJvbC5mb3IoXG4gICdXT1JLRkxPV19TVFJFQU1fU0VSVkVSX1JVTl9JRCdcbik7XG4vKipcbiAqIFN0YW1wZWQgYWxvbmdzaWRlIGBTVFJFQU1fU0VSVkVSX1JVTl9JRF9TWU1CT0xgIHdoZW4gdGhlIGRlcGxveW1lbnQgdGhhdFxuICogb3ducyBhIGZvcndhcmRlZCB3cml0YWJsZSBzdHJlYW0gaXMga25vd24uIENyb3NzLWRlcGxveW1lbnQgY29uc3VtZXJzIHVzZVxuICogaXQgdG8gcmVzb2x2ZSB0aGUgb3duaW5nIHJ1bidzIGVuY3J5cHRpb24ga2V5IHdpdGhvdXQgbG9hZGluZyB0aGUgcnVuIGZpcnN0LlxuICovXG5leHBvcnQgY29uc3QgU1RSRUFNX1NFUlZFUl9ERVBMT1lNRU5UX0lEX1NZTUJPTCA9IFN5bWJvbC5mb3IoXG4gICdXT1JLRkxPV19TVFJFQU1fU0VSVkVSX0RFUExPWU1FTlRfSUQnXG4pO1xuZXhwb3J0IGNvbnN0IEJPRFlfSU5JVF9TWU1CT0wgPSBTeW1ib2wuZm9yKCdCT0RZX0lOSVQnKTtcbmV4cG9ydCBjb25zdCBXRUJIT09LX1JFU1BPTlNFX1dSSVRBQkxFID0gU3ltYm9sLmZvcihcbiAgJ1dFQkhPT0tfUkVTUE9OU0VfV1JJVEFCTEUnXG4pO1xuXG4vKipcbiAqIFN5bWJvbCB1c2VkIHRvIHN0b3JlIHRoZSBjbGFzcyByZWdpc3RyeSBvbiBnbG9iYWxUaGlzIGluIHdvcmtmbG93IG1vZGUuXG4gKiBUaGlzIGFsbG93cyB0aGUgZGVzZXJpYWxpemVyIHRvIGZpbmQgY2xhc3NlcyBieSBjbGFzc0lkIGluIHRoZSBWTSBjb250ZXh0LlxuICovXG5leHBvcnQgY29uc3QgV09SS0ZMT1dfQ0xBU1NfUkVHSVNUUlkgPSBTeW1ib2wuZm9yKCd3b3JrZmxvdy1jbGFzcy1yZWdpc3RyeScpO1xuIiwgImltcG9ydCB7IGNyZWF0ZVdvcmtmbG93VXJsIH0gZnJvbSAnQHdvcmtmbG93L3V0aWxzJztcbmltcG9ydCB0eXBlIHtcbiAgSG9vayxcbiAgSG9va09wdGlvbnMsXG4gIFJlcXVlc3RXaXRoUmVzcG9uc2UsXG4gIFdlYmhvb2ssXG4gIFdlYmhvb2tPcHRpb25zLFxufSBmcm9tICcuLi9jcmVhdGUtaG9vay5qcyc7XG5pbXBvcnQgeyBXT1JLRkxPV19DUkVBVEVfSE9PSyB9IGZyb20gJy4uL3N5bWJvbHMuanMnO1xuaW1wb3J0IHsgZ2V0V29ya2Zsb3dNZXRhZGF0YSB9IGZyb20gJy4vZ2V0LXdvcmtmbG93LW1ldGFkYXRhLmpzJztcblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUhvb2s8VCA9IGFueT4ob3B0aW9ucz86IEhvb2tPcHRpb25zKTogSG9vazxUPiB7XG4gIC8vIEluc2lkZSB0aGUgd29ya2Zsb3cgVk0sIHRoZSBob29rIGZ1bmN0aW9uIGlzIHN0b3JlZCBpbiB0aGUgZ2xvYmFsVGhpcyBvYmplY3QgYmVoaW5kIGEgc3ltYm9sXG4gIGNvbnN0IGNyZWF0ZUhvb2tGbiA9IChnbG9iYWxUaGlzIGFzIGFueSlbXG4gICAgV09SS0ZMT1dfQ1JFQVRFX0hPT0tcbiAgXSBhcyB0eXBlb2YgY3JlYXRlSG9vazxUPjtcbiAgaWYgKCFjcmVhdGVIb29rRm4pIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAnYGNyZWF0ZUhvb2soKWAgY2FuIG9ubHkgYmUgY2FsbGVkIGluc2lkZSBhIHdvcmtmbG93IGZ1bmN0aW9uJ1xuICAgICk7XG4gIH1cbiAgcmV0dXJuIGNyZWF0ZUhvb2tGbihvcHRpb25zKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVdlYmhvb2soXG4gIG9wdGlvbnM6IFdlYmhvb2tPcHRpb25zICYgeyByZXNwb25kV2l0aDogJ21hbnVhbCcgfVxuKTogV2ViaG9vazxSZXF1ZXN0V2l0aFJlc3BvbnNlPjtcbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVXZWJob29rKG9wdGlvbnM/OiBXZWJob29rT3B0aW9ucyk6IFdlYmhvb2s8UmVxdWVzdD47XG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlV2ViaG9vayhcbiAgb3B0aW9ucz86IFdlYmhvb2tPcHRpb25zXG4pOiBXZWJob29rPFJlcXVlc3Q+IHwgV2ViaG9vazxSZXF1ZXN0V2l0aFJlc3BvbnNlPiB7XG4gIGNvbnN0IHsgcmVzcG9uZFdpdGgsIHRva2VuLCAuLi5yZXN0IH0gPSAob3B0aW9ucyA/PyB7fSkgYXMgV2ViaG9va09wdGlvbnMgJiB7XG4gICAgdG9rZW4/OiBzdHJpbmc7XG4gIH07XG5cbiAgaWYgKHRva2VuICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAnYGNyZWF0ZVdlYmhvb2soKWAgZG9lcyBub3QgYWNjZXB0IGEgYHRva2VuYCBvcHRpb24uIFdlYmhvb2sgdG9rZW5zIGFyZSBhbHdheXMgcmFuZG9tbHkgZ2VuZXJhdGVkLiBVc2UgYGNyZWF0ZUhvb2soKWAgd2l0aCBgcmVzdW1lSG9vaygpYCBmb3IgZGV0ZXJtaW5pc3RpYyB0b2tlbiBwYXR0ZXJucy4nXG4gICAgKTtcbiAgfVxuXG4gIGxldCBtZXRhZGF0YTogUGljazxXZWJob29rT3B0aW9ucywgJ3Jlc3BvbmRXaXRoJz4gfCB1bmRlZmluZWQ7XG4gIGlmICh0eXBlb2YgcmVzcG9uZFdpdGggIT09ICd1bmRlZmluZWQnKSB7XG4gICAgbWV0YWRhdGEgPSB7IHJlc3BvbmRXaXRoIH07XG4gIH1cblxuICBjb25zdCBob29rID0gY3JlYXRlSG9vayh7IC4uLnJlc3QsIG1ldGFkYXRhLCBpc1dlYmhvb2s6IHRydWUgfSkgYXNcbiAgICB8IFdlYmhvb2s8UmVxdWVzdD5cbiAgICB8IFdlYmhvb2s8UmVxdWVzdFdpdGhSZXNwb25zZT47XG5cbiAgY29uc3QgeyB1cmwgfSA9IGdldFdvcmtmbG93TWV0YWRhdGEoKTtcbiAgaG9vay51cmwgPSBjcmVhdGVXb3JrZmxvd1VybCh1cmwsIHsgdHlwZTogJ3dlYmhvb2snLCB0b2tlbjogaG9vay50b2tlbiB9KTtcblxuICByZXR1cm4gaG9vaztcbn1cbiIsICIvKipcbiAqIFRoaXMgaXMgdGhlIFwic3RhbmRhcmQgbGlicmFyeVwiIG9mIHN0ZXBzIHRoYXQgd2UgbWFrZSBhdmFpbGFibGUgdG8gYWxsIHdvcmtmbG93IHVzZXJzLlxuICogVGhlIGNhbiBiZSBpbXBvcnRlZCBsaWtlIHNvOiBgaW1wb3J0IHsgZmV0Y2ggfSBmcm9tICd3b3JrZmxvdydgLiBhbmQgdXNlZCBpbiB3b3JrZmxvdy5cbiAqIFRoZSBuZWVkIHRvIGJlIGV4cG9ydGVkIGRpcmVjdGx5IGluIHRoaXMgcGFja2FnZSBhbmQgY2Fubm90IGxpdmUgaW4gYGNvcmVgIHRvIHByZXZlbnRcbiAqIGNpcmN1bGFyIGRlcGVuZGVuY2llcyBwb3N0LWNvbXBpbGF0aW9uLlxuICovXG5cbi8qKlxuICogQSBob2lzdGVkIGBmZXRjaCgpYCBmdW5jdGlvbiB0aGF0IGlzIGV4ZWN1dGVkIGFzIGEgXCJzdGVwXCIgZnVuY3Rpb24sXG4gKiBmb3IgdXNlIHdpdGhpbiB3b3JrZmxvdyBmdW5jdGlvbnMuXG4gKlxuICogQHNlZSBodHRwczovL2RldmVsb3Blci5tb3ppbGxhLm9yZy9lbi1VUy9kb2NzL1dlYi9BUEkvRmV0Y2hfQVBJXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaCguLi5hcmdzOiBQYXJhbWV0ZXJzPHR5cGVvZiBnbG9iYWxUaGlzLmZldGNoPikge1xuICAndXNlIHN0ZXAnO1xuICByZXR1cm4gZ2xvYmFsVGhpcy5mZXRjaCguLi5hcmdzKTtcbn1cbiIsICJmdW5jdGlvbiBfdHNfYWRkX2Rpc3Bvc2FibGVfcmVzb3VyY2UoZW52LCB2YWx1ZSwgYXN5bmMpIHtcbiAgICBpZiAodmFsdWUgIT09IG51bGwgJiYgdmFsdWUgIT09IHZvaWQgMCkge1xuICAgICAgICBpZiAodHlwZW9mIHZhbHVlICE9PSBcIm9iamVjdFwiICYmIHR5cGVvZiB2YWx1ZSAhPT0gXCJmdW5jdGlvblwiKSB0aHJvdyBuZXcgVHlwZUVycm9yKFwiT2JqZWN0IGV4cGVjdGVkLlwiKTtcbiAgICAgICAgdmFyIGRpc3Bvc2UsIGlubmVyO1xuICAgICAgICBpZiAoYXN5bmMpIHtcbiAgICAgICAgICAgIGlmICghU3ltYm9sLmFzeW5jRGlzcG9zZSkgdGhyb3cgbmV3IFR5cGVFcnJvcihcIlN5bWJvbC5hc3luY0Rpc3Bvc2UgaXMgbm90IGRlZmluZWQuXCIpO1xuICAgICAgICAgICAgZGlzcG9zZSA9IHZhbHVlW1N5bWJvbC5hc3luY0Rpc3Bvc2VdO1xuICAgICAgICB9XG4gICAgICAgIGlmIChkaXNwb3NlID09PSB2b2lkIDApIHtcbiAgICAgICAgICAgIGlmICghU3ltYm9sLmRpc3Bvc2UpIHRocm93IG5ldyBUeXBlRXJyb3IoXCJTeW1ib2wuZGlzcG9zZSBpcyBub3QgZGVmaW5lZC5cIik7XG4gICAgICAgICAgICBkaXNwb3NlID0gdmFsdWVbU3ltYm9sLmRpc3Bvc2VdO1xuICAgICAgICAgICAgaWYgKGFzeW5jKSBpbm5lciA9IGRpc3Bvc2U7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHR5cGVvZiBkaXNwb3NlICE9PSBcImZ1bmN0aW9uXCIpIHRocm93IG5ldyBUeXBlRXJyb3IoXCJPYmplY3Qgbm90IGRpc3Bvc2FibGUuXCIpO1xuICAgICAgICBpZiAoaW5uZXIpIGRpc3Bvc2UgPSBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgaW5uZXIuY2FsbCh0aGlzKTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgICAgIGVudi5zdGFjay5wdXNoKHtcbiAgICAgICAgICAgIHZhbHVlOiB2YWx1ZSxcbiAgICAgICAgICAgIGRpc3Bvc2U6IGRpc3Bvc2UsXG4gICAgICAgICAgICBhc3luYzogYXN5bmNcbiAgICAgICAgfSk7XG4gICAgfSBlbHNlIGlmIChhc3luYykge1xuICAgICAgICBlbnYuc3RhY2sucHVzaCh7XG4gICAgICAgICAgICBhc3luYzogdHJ1ZVxuICAgICAgICB9KTtcbiAgICB9XG4gICAgcmV0dXJuIHZhbHVlO1xufVxuZnVuY3Rpb24gX3RzX2Rpc3Bvc2VfcmVzb3VyY2VzKGVudikge1xuICAgIHZhciBfU3VwcHJlc3NlZEVycm9yID0gdHlwZW9mIFN1cHByZXNzZWRFcnJvciA9PT0gXCJmdW5jdGlvblwiID8gU3VwcHJlc3NlZEVycm9yIDogZnVuY3Rpb24oZXJyb3IsIHN1cHByZXNzZWQsIG1lc3NhZ2UpIHtcbiAgICAgICAgdmFyIGUgPSBuZXcgRXJyb3IobWVzc2FnZSk7XG4gICAgICAgIHJldHVybiBlLm5hbWUgPSBcIlN1cHByZXNzZWRFcnJvclwiLCBlLmVycm9yID0gZXJyb3IsIGUuc3VwcHJlc3NlZCA9IHN1cHByZXNzZWQsIGU7XG4gICAgfTtcbiAgICByZXR1cm4gKF90c19kaXNwb3NlX3Jlc291cmNlcyA9IGZ1bmN0aW9uIF90c19kaXNwb3NlX3Jlc291cmNlcyhlbnYpIHtcbiAgICAgICAgZnVuY3Rpb24gZmFpbChlKSB7XG4gICAgICAgICAgICBlbnYuZXJyb3IgPSBlbnYuaGFzRXJyb3IgPyBuZXcgX1N1cHByZXNzZWRFcnJvcihlLCBlbnYuZXJyb3IsIFwiQW4gZXJyb3Igd2FzIHN1cHByZXNzZWQgZHVyaW5nIGRpc3Bvc2FsLlwiKSA6IGU7XG4gICAgICAgICAgICBlbnYuaGFzRXJyb3IgPSB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIHZhciByLCBzID0gMDtcbiAgICAgICAgZnVuY3Rpb24gbmV4dCgpIHtcbiAgICAgICAgICAgIHdoaWxlKHIgPSBlbnYuc3RhY2sucG9wKCkpe1xuICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghci5hc3luYyAmJiBzID09PSAxKSByZXR1cm4gcyA9IDAsIGVudi5zdGFjay5wdXNoKHIpLCBQcm9taXNlLnJlc29sdmUoKS50aGVuKG5leHQpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoci5kaXNwb3NlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB2YXIgcmVzdWx0ID0gci5kaXNwb3NlLmNhbGwoci52YWx1ZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoci5hc3luYykgcmV0dXJuIHMgfD0gMiwgUHJvbWlzZS5yZXNvbHZlKHJlc3VsdCkudGhlbihuZXh0LCBmdW5jdGlvbihlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmFpbChlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gbmV4dCgpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSBzIHw9IDE7XG4gICAgICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICAgICAgICBmYWlsKGUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChzID09PSAxKSByZXR1cm4gZW52Lmhhc0Vycm9yID8gUHJvbWlzZS5yZWplY3QoZW52LmVycm9yKSA6IFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICAgICAgaWYgKGVudi5oYXNFcnJvcikgdGhyb3cgZW52LmVycm9yO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBuZXh0KCk7XG4gICAgfSkoZW52KTtcbn1cbmltcG9ydCB7IGNyZWF0ZUhvb2sgfSBmcm9tIFwid29ya2Zsb3dcIjtcbi8qKl9faW50ZXJuYWxfd29ya2Zsb3dze1wid29ya2Zsb3dzXCI6e1wid29ya2Zsb3dzL2dhdGUudHNcIjp7XCJnYXRlV29ya2Zsb3dcIjp7XCJ3b3JrZmxvd0lkXCI6XCJ3b3JrZmxvdy8vLi93b3JrZmxvd3MvZ2F0ZS8vZ2F0ZVdvcmtmbG93XCJ9fX0sXCJzdGVwc1wiOntcIndvcmtmbG93cy9nYXRlLnRzXCI6e1wic3RlcE9uZVwiOntcInN0ZXBJZFwiOlwic3RlcC8vLi93b3JrZmxvd3MvZ2F0ZS8vc3RlcE9uZVwifSxcInN0ZXBUd29cIjp7XCJzdGVwSWRcIjpcInN0ZXAvLy4vd29ya2Zsb3dzL2dhdGUvL3N0ZXBUd29cIn19fX0qLztcbi8vIENyaXRlcmlvbiA1IGdhdGU6IHN0ZXAgLT4gc3VzcGVuZCBvbiBob29rIC0+IHN0ZXAuXG4vLyBzdGVwT25lJ3MgbWFya2VyIHByb3ZlcyBtZW1vaXphdGlvbiBhY3Jvc3MgYSBwcm9jZXNzIGtpbGw6IGlmIHRoZSBydW5cbi8vIHRydWx5IHJlc3VtZXMgKG5vdCByZS1leGVjdXRlcyksIHRoZSBmaW5hbCByZXN1bHQgY2FycmllcyB0aGUgc2FtZSBtYXJrZXJcbi8vIHRoYXQgd2FzIGxvZ2dlZCBiZWZvcmUgdGhlIGtpbGwsIGFuZCBcIltzdGVwT25lXSBleGVjdXRlZFwiIGFwcGVhcnMgb25jZS5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnYXRlV29ya2Zsb3coZ2F0ZUlkKSB7XG4gICAgY29uc3QgZW52ID0ge1xuICAgICAgICBzdGFjazogW10sXG4gICAgICAgIGVycm9yOiB2b2lkIDAsXG4gICAgICAgIGhhc0Vycm9yOiBmYWxzZVxuICAgIH07XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3Qgb25lID0gYXdhaXQgc3RlcE9uZShnYXRlSWQpO1xuICAgICAgICBjb25zdCBob29rID0gX3RzX2FkZF9kaXNwb3NhYmxlX3Jlc291cmNlKGVudiwgY3JlYXRlSG9vayh7XG4gICAgICAgICAgICB0b2tlbjogYGdhdGU6JHtnYXRlSWR9YFxuICAgICAgICB9KSwgZmFsc2UpO1xuICAgICAgICBjb25zdCBhcHByb3ZhbCA9IGF3YWl0IGhvb2s7XG4gICAgICAgIGNvbnN0IHR3byA9IGF3YWl0IHN0ZXBUd28ob25lLm1hcmtlciwgYXBwcm92YWwpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgc3RlcE9uZTogb25lLFxuICAgICAgICAgICAgYXBwcm92YWwsXG4gICAgICAgICAgICBzdGVwVHdvOiB0d29cbiAgICAgICAgfTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGVudi5lcnJvciA9IGU7XG4gICAgICAgIGVudi5oYXNFcnJvciA9IHRydWU7XG4gICAgfSBmaW5hbGx5e1xuICAgICAgICBfdHNfZGlzcG9zZV9yZXNvdXJjZXMoZW52KTtcbiAgICB9XG59XG5nYXRlV29ya2Zsb3cud29ya2Zsb3dJZCA9IFwid29ya2Zsb3cvLy4vd29ya2Zsb3dzL2dhdGUvL2dhdGVXb3JrZmxvd1wiO1xuZ2xvYmFsVGhpcy5fX3ByaXZhdGVfd29ya2Zsb3dzLnNldChcIndvcmtmbG93Ly8uL3dvcmtmbG93cy9nYXRlLy9nYXRlV29ya2Zsb3dcIiwgZ2F0ZVdvcmtmbG93KTtcbnZhciBzdGVwT25lID0gZ2xvYmFsVGhpc1tTeW1ib2wuZm9yKFwiV09SS0ZMT1dfVVNFX1NURVBcIildKFwic3RlcC8vLi93b3JrZmxvd3MvZ2F0ZS8vc3RlcE9uZVwiKTtcbnZhciBzdGVwVHdvID0gZ2xvYmFsVGhpc1tTeW1ib2wuZm9yKFwiV09SS0ZMT1dfVVNFX1NURVBcIildKFwic3RlcC8vLi93b3JrZmxvd3MvZ2F0ZS8vc3RlcFR3b1wiKTtcbiIsICIvKipfX2ludGVybmFsX3dvcmtmbG93c3tcIndvcmtmbG93c1wiOntcIndvcmtmbG93cy9wcm9iZS50c1wiOntcInNlcmlhbGl6YXRpb25Qcm9iZVwiOntcIndvcmtmbG93SWRcIjpcIndvcmtmbG93Ly8uL3dvcmtmbG93cy9wcm9iZS8vc2VyaWFsaXphdGlvblByb2JlXCJ9fX0sXCJzdGVwc1wiOntcIndvcmtmbG93cy9wcm9iZS50c1wiOntcInByb2JlU3RlcFwiOntcInN0ZXBJZFwiOlwic3RlcC8vLi93b3JrZmxvd3MvcHJvYmUvL3Byb2JlU3RlcFwifX19fSovO1xuLy8gQ3JpdGVyaW9uIDg6IHByb3ZlIGEgbm9uLXNlcmlhbGl6YWJsZSB2YWx1ZSBjYW5ub3QgY3Jvc3MgdGhlXG4vLyB3b3JrZmxvdy9zdGVwIGJvdW5kYXJ5LiBBIGxpdmUgZnVuY3Rpb24gcmlkZXMgYWxvbmcgYXMgaW5wdXQuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2VyaWFsaXphdGlvblByb2JlKCkge1xuICAgIGNvbnN0IGxpdmVPYmplY3QgPSB7XG4gICAgICAgIGxhYmVsOiBcImxpdmUtb2JqZWN0XCIsXG4gICAgICAgIGZuOiAoKT0+NDJcbiAgICB9O1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHByb2JlU3RlcChsaXZlT2JqZWN0KTtcbiAgICByZXR1cm4ge1xuICAgICAgICByZXN1bHRcbiAgICB9O1xufVxuc2VyaWFsaXphdGlvblByb2JlLndvcmtmbG93SWQgPSBcIndvcmtmbG93Ly8uL3dvcmtmbG93cy9wcm9iZS8vc2VyaWFsaXphdGlvblByb2JlXCI7XG5nbG9iYWxUaGlzLl9fcHJpdmF0ZV93b3JrZmxvd3Muc2V0KFwid29ya2Zsb3cvLy4vd29ya2Zsb3dzL3Byb2JlLy9zZXJpYWxpemF0aW9uUHJvYmVcIiwgc2VyaWFsaXphdGlvblByb2JlKTtcbnZhciBwcm9iZVN0ZXAgPSBnbG9iYWxUaGlzW1N5bWJvbC5mb3IoXCJXT1JLRkxPV19VU0VfU1RFUFwiKV0oXCJzdGVwLy8uL3dvcmtmbG93cy9wcm9iZS8vcHJvYmVTdGVwXCIpO1xuIiwgIi8qKl9faW50ZXJuYWxfd29ya2Zsb3dze1wid29ya2Zsb3dzXCI6e1wid29ya2Zsb3dzL3Nsb3cudHNcIjp7XCJzbG93V29ya2Zsb3dcIjp7XCJ3b3JrZmxvd0lkXCI6XCJ3b3JrZmxvdy8vLi93b3JrZmxvd3Mvc2xvdy8vc2xvd1dvcmtmbG93XCJ9fX0sXCJzdGVwc1wiOntcIndvcmtmbG93cy9zbG93LnRzXCI6e1wiYWZ0ZXJTdGVwXCI6e1wic3RlcElkXCI6XCJzdGVwLy8uL3dvcmtmbG93cy9zbG93Ly9hZnRlclN0ZXBcIn0sXCJzbG93U3RlcFwiOntcInN0ZXBJZFwiOlwic3RlcC8vLi93b3JrZmxvd3Mvc2xvdy8vc2xvd1N0ZXBcIn19fX0qLztcbi8vIE1pZC1zdGVwIGtpbGwgdGVzdDogc2xvd1N0ZXAgYWN0aXZlbHkgZXhlY3V0ZXMgZm9yIDkwcyBzbyB0aGUgcHJvY2VzcyBjYW5cbi8vIGJlIGtpbGxlZCB3aGlsZSBhIHN0ZXAgaXMgSU4gRkxJR0hUICh2cyB0aGUgZ2F0ZSB0ZXN0J3MgaWRsZSBzdXNwZW5zaW9uKS5cbi8vIFRoZSBtYXJrZXIgdGVsbHMgcmUtZXhlY3V0aW9uIChuZXcgbWFya2VyKSBmcm9tIHJlcGxheSAoc2FtZSBtYXJrZXIpLlxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNsb3dXb3JrZmxvdyhpZCwgc2Vjb25kcykge1xuICAgIGNvbnN0IG9uZSA9IGF3YWl0IHNsb3dTdGVwKGlkLCBzZWNvbmRzKTtcbiAgICBjb25zdCB0d28gPSBhd2FpdCBhZnRlclN0ZXAob25lLm1hcmtlcik7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgc2xvd1N0ZXA6IG9uZSxcbiAgICAgICAgYWZ0ZXJTdGVwOiB0d29cbiAgICB9O1xufVxuc2xvd1dvcmtmbG93LndvcmtmbG93SWQgPSBcIndvcmtmbG93Ly8uL3dvcmtmbG93cy9zbG93Ly9zbG93V29ya2Zsb3dcIjtcbmdsb2JhbFRoaXMuX19wcml2YXRlX3dvcmtmbG93cy5zZXQoXCJ3b3JrZmxvdy8vLi93b3JrZmxvd3Mvc2xvdy8vc2xvd1dvcmtmbG93XCIsIHNsb3dXb3JrZmxvdyk7XG52YXIgc2xvd1N0ZXAgPSBnbG9iYWxUaGlzW1N5bWJvbC5mb3IoXCJXT1JLRkxPV19VU0VfU1RFUFwiKV0oXCJzdGVwLy8uL3dvcmtmbG93cy9zbG93Ly9zbG93U3RlcFwiKTtcbnZhciBhZnRlclN0ZXAgPSBnbG9iYWxUaGlzW1N5bWJvbC5mb3IoXCJXT1JLRkxPV19VU0VfU1RFUFwiKV0oXCJzdGVwLy8uL3dvcmtmbG93cy9zbG93Ly9hZnRlclN0ZXBcIik7XG4iXSwKICAibWFwcGluZ3MiOiAiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQTtBQUFBLGtFQUFBQSxTQUFBO0FBRUksUUFBSSxJQUFJO0FBQ1osUUFBSSxJQUFJLElBQUk7QUFDWixRQUFJLElBQUksSUFBSTtBQUNaLFFBQUksSUFBSSxJQUFJO0FBQ1osUUFBSSxJQUFJLElBQUk7QUFDWixRQUFJLElBQUksSUFBSTtBQWFSLElBQUFBLFFBQU8sVUFBVSxTQUFTLEtBQUssU0FBUztBQUN4QyxnQkFBVSxXQUFXLENBQUM7QUFDdEIsVUFBSSxPQUFPLE9BQU87QUFDbEIsVUFBSSxTQUFTLFlBQVksSUFBSSxTQUFTLEdBQUc7QUFDckMsZUFBTyxNQUFNLEdBQUc7QUFBQSxNQUNwQixXQUFXLFNBQVMsWUFBWSxTQUFTLEdBQUcsR0FBRztBQUMzQyxlQUFPLFFBQVEsT0FBTyxRQUFRLEdBQUcsSUFBSSxTQUFTLEdBQUc7QUFBQSxNQUNyRDtBQUNBLFlBQU0sSUFBSSxNQUFNLDBEQUEwRCxLQUFLLFVBQVUsR0FBRyxDQUFDO0FBQUEsSUFDakc7QUFPSSxhQUFTLE1BQU0sS0FBSztBQUNwQixZQUFNLE9BQU8sR0FBRztBQUNoQixVQUFJLElBQUksU0FBUyxLQUFLO0FBQ2xCO0FBQUEsTUFDSjtBQUNBLFVBQUksUUFBUSxtSUFBbUksS0FBSyxHQUFHO0FBQ3ZKLFVBQUksQ0FBQyxPQUFPO0FBQ1I7QUFBQSxNQUNKO0FBQ0EsVUFBSSxJQUFJLFdBQVcsTUFBTSxDQUFDLENBQUM7QUFDM0Is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
`);
//#endregion
//#region #workflow/workflows.mjs
var workflows_default = async ({ req }) => {
	try {
		return await POST(req);
	} catch (error) {
		console.error("Handler error:", error);
		return new Response("Internal Server Error", { status: 500 });
	}
};
//#endregion
//#region #nitro/virtual/public-assets-data
var public_assets_data_default = {};
//#endregion
//#region #nitro/virtual/public-assets-node
function readAsset(id) {
	const serverDir = dirname(fileURLToPath(globalThis.__nitro_main__));
	return promises.readFile(resolve(serverDir, public_assets_data_default[id].path));
}
//#endregion
//#region #nitro/virtual/public-assets
const publicAssetBases = {};
function isPublicAssetURL(id = "") {
	if (public_assets_data_default[id]) return true;
	for (const base in publicAssetBases) if (id.startsWith(base)) return true;
	return false;
}
function getAsset(id) {
	return public_assets_data_default[id];
}
//#endregion
//#region node_modules/.pnpm/nitro@3.0.260610-beta_@vercel+functions@3.9.5_@aws-sdk+credential-provider-web-identity_4cdea0c3e92f6e79d968835f3426acc8/node_modules/nitro/dist/runtime/internal/static.mjs
const METHODS = /* @__PURE__ */ new Set(["HEAD", "GET"]);
const EncodingMap = {
	gzip: ".gz",
	br: ".br",
	zstd: ".zst"
};
var static_default = defineHandler((event) => {
	if (event.req.method && !METHODS.has(event.req.method)) return;
	let id = decodePath(withLeadingSlash(withoutTrailingSlash(event.url.pathname)));
	let asset;
	const encodings = [...(event.req.headers.get("accept-encoding") || "").split(",").map((e) => EncodingMap[e.trim()]).filter(Boolean).sort(), ""];
	for (const encoding of encodings) for (const _id of [id + encoding, joinURL(id, "index.html" + encoding)]) {
		const _asset = getAsset(_id);
		if (_asset) {
			asset = _asset;
			id = _id;
			break;
		}
	}
	if (!asset) {
		if (isPublicAssetURL(id)) {
			event.res.headers.delete("Cache-Control");
			throw new HTTPError({ status: 404 });
		}
		return;
	}
	if (encodings.length > 1) event.res.headers.append("Vary", "Accept-Encoding");
	if (event.req.headers.get("if-none-match") === asset.etag) {
		event.res.status = 304;
		event.res.statusText = "Not Modified";
		return "";
	}
	const ifModifiedSinceH = event.req.headers.get("if-modified-since");
	const mtimeDate = new Date(asset.mtime);
	if (ifModifiedSinceH && asset.mtime && new Date(ifModifiedSinceH) >= mtimeDate) {
		event.res.status = 304;
		event.res.statusText = "Not Modified";
		return "";
	}
	if (asset.type) event.res.headers.set("Content-Type", asset.type);
	if (asset.etag && !event.res.headers.has("ETag")) event.res.headers.set("ETag", asset.etag);
	if (asset.mtime && !event.res.headers.has("Last-Modified")) event.res.headers.set("Last-Modified", mtimeDate.toUTCString());
	if (asset.encoding && !event.res.headers.has("Content-Encoding")) event.res.headers.set("Content-Encoding", asset.encoding);
	if (asset.size > 0 && !event.res.headers.has("Content-Length")) event.res.headers.set("Content-Length", asset.size.toString());
	return readAsset(id);
});
//#endregion
//#region #nitro/virtual/routing
const findRoute = /* @__PURE__ */ (() => {
	const $0 = {
		route: "/.well-known/workflow/v1/step",
		handler: toEventHandler(steps_default)
	}, $1 = {
		route: "/.well-known/workflow/v1/flow",
		handler: toEventHandler(workflows_default)
	}, $2 = {
		route: "/.well-known/workflow/v1/webhook/:token",
		handler: toEventHandler(webhook_default)
	}, $3 = {
		route: "/**",
		handler: toEventHandler(app)
	};
	return (m, p) => {
		if (p.charCodeAt(p.length - 1) === 47) p = p.slice(0, -1) || "/";
		if (p === "/.well-known/workflow/v1/step") return { data: $0 };
		else if (p === "/.well-known/workflow/v1/flow") return { data: $1 };
		let s = p.split("/"), l = s.length;
		if (l > 1) {
			if (s[1] === ".well-known") {
				if (l > 2) {
					if (s[2] === "workflow") {
						if (l > 3) {
							if (s[3] === "v1") {
								if (l > 4) {
									if (s[4] === "webhook") {
										if (l === 6 || l === 5) {
											if (l > 5) return {
												data: $2,
												params: { "token": s[5] }
											};
										}
									}
								}
							}
						}
					}
				}
			}
		}
		return {
			data: $3,
			params: { "_": s.slice(1).join("/") }
		};
	};
})();
const globalMiddleware = [toEventHandler(static_default)].filter(Boolean);
//#endregion
//#region node_modules/.pnpm/nitro@3.0.260610-beta_@vercel+functions@3.9.5_@aws-sdk+credential-provider-web-identity_4cdea0c3e92f6e79d968835f3426acc8/node_modules/nitro/dist/runtime/internal/error/prod.mjs
const errorHandler = (error, event) => {
	const res = defaultHandler(error, event);
	return new NodeResponse(typeof res.body === "string" ? res.body : JSON.stringify(res.body, null, 2), res);
};
function defaultHandler(error, event) {
	const unhandled = error.unhandled ?? !HTTPError.isError(error);
	const { status = 500, statusText = "" } = unhandled ? {} : error;
	if (status === 404) {
		const url = event.url || new URL(event.req.url);
		const baseURL = "/";
		if (/^\/[^/]/.test(baseURL) && !url.pathname.startsWith(baseURL)) return {
			status: 302,
			headers: new Headers({ location: `${baseURL}${url.pathname.slice(1)}${url.search}` })
		};
	}
	const headers = new Headers(unhandled ? {} : error.headers);
	headers.set("content-type", "application/json; charset=utf-8");
	return {
		status,
		statusText,
		headers,
		body: {
			error: true,
			...unhandled ? {
				status,
				unhandled: true
			} : typeof error.toJSON === "function" ? error.toJSON() : {
				status,
				statusText,
				message: error.message
			}
		}
	};
}
//#endregion
//#region #nitro/virtual/error-handler
const errorHandlers = [errorHandler];
async function error_handler_default(error, event) {
	for (const handler of errorHandlers) try {
		const response = await handler(error, event, { defaultHandler });
		if (response) return response;
	} catch (error) {
		console.error(error);
	}
}
//#endregion
//#region plugins/start-world.ts
async function startWorld() {
	const { getWorld } = await import("./_libs/workflow.mjs").then((n) => n.t);
	await getWorld().start?.();
	console.log(`[proto] world started: ${process.env.WORKFLOW_TARGET_WORLD ?? "local (default)"}`);
}
//#endregion
//#region #nitro/virtual/plugins
const plugins = [startWorld];
//#endregion
//#region #nitro/virtual/app
function createNitroApp() {
	const hooks = new HookableCore();
	const captureError = (error, errorCtx) => {
		const promise = hooks.callHook("error", error, errorCtx)?.catch?.((hookError) => {
			console.error("Error while capturing another error", hookError);
		});
		if (errorCtx?.event) {
			const errors = errorCtx.event.req.context?.nitro?.errors;
			if (errors) errors.push({
				error,
				context: errorCtx
			});
			if (promise && typeof errorCtx.event.req.waitUntil === "function") errorCtx.event.req.waitUntil(promise);
		}
	};
	const h3App = createH3App({ onError(error, event) {
		captureError(error, { event });
		return error_handler_default(error, event);
	} });
	h3App.config.onRequest = (event) => {
		return hooks.callHook("request", event)?.catch?.((error) => {
			captureError(error, {
				event,
				tags: ["request"]
			});
		});
	};
	h3App.config.onResponse = (res, event) => {
		return hooks.callHook("response", res, event)?.catch?.((error) => {
			captureError(error, {
				event,
				tags: ["response"]
			});
		});
	};
	let appHandler = (req) => {
		req.context ||= {};
		req.context.nitro = req.context.nitro || { errors: [] };
		return h3App.fetch(req);
	};
	return {
		fetch: appHandler,
		h3: h3App,
		hooks,
		captureError
	};
}
function initNitroPlugins(app) {
	for (const plugin of plugins) try {
		plugin(app);
	} catch (error) {
		app.captureError?.(error, { tags: ["plugin"] });
		throw error;
	}
	return app;
}
function createH3App(config) {
	const h3App = new H3Core(config);
	h3App["~findRoute"] = (event) => findRoute(event.req.method, event.url.pathname);
	h3App["~middleware"].push(...globalMiddleware);
	return h3App;
}
//#endregion
//#region node_modules/.pnpm/nitro@3.0.260610-beta_@vercel+functions@3.9.5_@aws-sdk+credential-provider-web-identity_4cdea0c3e92f6e79d968835f3426acc8/node_modules/nitro/dist/runtime/internal/app.mjs
const APP_ID = "default";
function useNitroApp() {
	let instance = useNitroApp._instance;
	if (instance) return instance;
	instance = useNitroApp._instance = createNitroApp();
	globalThis.__nitro__ = globalThis.__nitro__ || {};
	globalThis.__nitro__[APP_ID] = instance;
	initNitroPlugins(instance);
	return instance;
}
//#endregion
//#region node_modules/.pnpm/nitro@3.0.260610-beta_@vercel+functions@3.9.5_@aws-sdk+credential-provider-web-identity_4cdea0c3e92f6e79d968835f3426acc8/node_modules/nitro/dist/runtime/internal/error/hooks.mjs
function _captureError(error, type) {
	console.error(`[${type}]`, error);
	useNitroApp().captureError?.(error, { tags: [type] });
}
function trapUnhandledErrors() {
	process.on("unhandledRejection", (error) => _captureError(error, "unhandledRejection"));
	process.on("uncaughtException", (error) => _captureError(error, "uncaughtException"));
}
//#endregion
//#region #nitro/virtual/tracing
const tracingSrvxPlugins = [];
//#endregion
//#region node_modules/.pnpm/nitro@3.0.260610-beta_@vercel+functions@3.9.5_@aws-sdk+credential-provider-web-identity_4cdea0c3e92f6e79d968835f3426acc8/node_modules/nitro/dist/presets/node/runtime/node-server.mjs
const _parsedPort = Number.parseInt(process.env.NITRO_PORT ?? process.env.PORT ?? "");
const port = Number.isNaN(_parsedPort) ? 3e3 : _parsedPort;
const host = process.env.NITRO_HOST || process.env.HOST;
const cert = process.env.NITRO_SSL_CERT;
const key = process.env.NITRO_SSL_KEY;
const nitroApp = useNitroApp();
serve({
	port,
	hostname: host,
	tls: cert && key ? {
		cert,
		key
	} : void 0,
	fetch: nitroApp.fetch,
	plugins: [...tracingSrvxPlugins]
});
trapUnhandledErrors();
var node_server_default = {};
//#endregion
export { node_server_default as default };
