import { createRequire as __wkfCreateRequire } from "node:module";
if (typeof globalThis.require === "undefined") globalThis.require = __wkfCreateRequire(import.meta.url);
import { F as APICallError, L as LoadAPIKeyError, Lr as union, Qn as literal, R as NoSuchModelError, T as mapReasoningToProviderEffort, Tr as string, br as record, d as detectMediaType, dr as number, fr as object, h as generateId, mn as array, pn as any, sn as _enum, un as _null, vn as boolean, y as isCustomReasoning } from "./@ai-sdk/gateway+[...].mjs";
import { t as COt } from "./anthropic-ai__claude-agent-sdk.mjs";
import { existsSync } from "fs";
//#region node_modules/.pnpm/ai-sdk-provider-claude-code@4.1.1_@anthropic-ai+sdk@0.120.0_zod@4.3.6__@modelcontextpro_44aae83032f56bcd01f75b1a28dcae6f/node_modules/ai-sdk-provider-claude-code/dist/index.js
var IMAGE_URL_WARNING = "Image URLs are not supported by this provider; supply base64/data URLs.";
var IMAGE_CONVERSION_WARNING = "Unable to convert image content; supply base64/data URLs.";
var FILE_REFERENCE_WARNING = "Provider file references are not supported by this provider; supply inline file data.";
function createUnsupportedFilePartWarning(mediaType) {
	return `Unsupported file part (${mediaType && mediaType.trim() ? mediaType : "unknown"}) was ignored; this provider forwards only image file parts inline.`;
}
var MAX_TOOL_CALL_INPUT_LENGTH = 1e3;
function serializeToolCallInput(input) {
	let serialized;
	if (input === void 0) serialized = "";
	else try {
		serialized = JSON.stringify(input) ?? String(input);
	} catch {
		serialized = String(input);
	}
	if (serialized.length > MAX_TOOL_CALL_INPUT_LENGTH) return `${serialized.slice(0, MAX_TOOL_CALL_INPUT_LENGTH)}...[truncated]`;
	return serialized;
}
function getVariantName(value, discriminator) {
	if (typeof value === "object" && value !== null) {
		const candidate = value[discriminator];
		if (typeof candidate === "string" && candidate) return candidate;
	}
	return String(value);
}
function createUnknownPromptVariantWarning(value, context, discriminator = "type") {
	return `Unsupported ${context} ${discriminator} '${getVariantName(value, discriminator)}' was skipped.`;
}
function extractMimeType(candidate) {
	if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
}
function normalizeMediaType(mediaType) {
	return mediaType.trim().toLowerCase();
}
function isImageMimeType(mediaType) {
	if (!mediaType) return false;
	const normalized = normalizeMediaType(mediaType);
	return normalized === "image" || normalized === "image/*" || normalized.startsWith("image/");
}
function isConcreteImageMimeType(mediaType) {
	const normalized = normalizeMediaType(mediaType);
	return normalized.startsWith("image/") && !normalized.endsWith("/*");
}
function resolveImageMediaType(mediaType, data) {
	const normalizedMediaType = normalizeMediaType(mediaType);
	if (isConcreteImageMimeType(normalizedMediaType)) return normalizedMediaType;
	if ((normalizedMediaType === "image" || normalizedMediaType === "image/*") && data) try {
		const detectedMediaType = detectMediaType({
			data,
			topLevelType: "image"
		});
		if (detectedMediaType && isConcreteImageMimeType(detectedMediaType)) return detectedMediaType;
	} catch {
		return;
	}
}
function createImageContent(mediaType, data) {
	const normalizedType = normalizeMediaType(mediaType);
	const trimmedData = data.trim().replace(/\s+/g, "");
	if (!isConcreteImageMimeType(normalizedType) || !trimmedData) return;
	return {
		type: "image",
		source: {
			type: "base64",
			media_type: normalizedType,
			data: trimmedData
		}
	};
}
function resolveStringImageMediaType(mediaType, data, fallbackMimeType) {
	return resolveImageMediaType(mediaType, data) ?? (fallbackMimeType ? resolveImageMediaType(fallbackMimeType, data) : void 0);
}
function parseStringImage(value, fallbackMimeType) {
	const trimmed = value.trim();
	if (/^https?:\/\//i.test(trimmed)) return { warning: IMAGE_URL_WARNING };
	const dataUrlMatch = trimmed.match(/^data:([^;]+);base64,(.+)$/i);
	if (dataUrlMatch) {
		const [, mediaType, data] = dataUrlMatch;
		const resolvedMediaType = resolveStringImageMediaType(mediaType, data, fallbackMimeType);
		const content = resolvedMediaType ? createImageContent(resolvedMediaType, data) : void 0;
		return content ? { content } : { warning: IMAGE_CONVERSION_WARNING };
	}
	const base64Match = trimmed.match(/^base64:([^,]+),(.+)$/i);
	if (base64Match) {
		const [, explicitMimeType, data] = base64Match;
		const resolvedMediaType = resolveStringImageMediaType(explicitMimeType, data, fallbackMimeType);
		const content = resolvedMediaType ? createImageContent(resolvedMediaType, data) : void 0;
		return content ? { content } : { warning: IMAGE_CONVERSION_WARNING };
	}
	if (fallbackMimeType) {
		const resolvedMediaType = resolveImageMediaType(fallbackMimeType, trimmed);
		if (resolvedMediaType) {
			const content = createImageContent(resolvedMediaType, trimmed);
			if (content) return { content };
		}
	}
	return { warning: IMAGE_CONVERSION_WARNING };
}
function convertBinaryToBase64(data) {
	if (typeof Buffer !== "undefined") return (data instanceof Uint8Array ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data)).toString("base64");
	if (typeof btoa === "function") {
		const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
		let binary = "";
		const chunkSize = 32768;
		for (let i = 0; i < bytes.length; i += chunkSize) {
			const chunk = bytes.subarray(i, i + chunkSize);
			binary += String.fromCharCode(...chunk);
		}
		return btoa(binary);
	}
}
function parseFilePart(part) {
	const mediaType = extractMimeType(part.mediaType);
	const fileData = part.data;
	switch (fileData.type) {
		case "data": {
			if (!mediaType || !isImageMimeType(mediaType)) return { warning: createUnsupportedFilePartWarning(mediaType) };
			if (typeof fileData.data === "string") return parseStringImage(fileData.data, mediaType);
			const resolvedMediaType = resolveImageMediaType(mediaType, fileData.data);
			if (!resolvedMediaType) return { warning: IMAGE_CONVERSION_WARNING };
			const base64 = convertBinaryToBase64(fileData.data);
			if (!base64) return { warning: IMAGE_CONVERSION_WARNING };
			const content = createImageContent(resolvedMediaType, base64);
			return content ? { content } : { warning: IMAGE_CONVERSION_WARNING };
		}
		case "url": {
			if (!mediaType || !isImageMimeType(mediaType)) return { warning: createUnsupportedFilePartWarning(mediaType) };
			const url = fileData.url.toString();
			if (!/^data:/i.test(url.trim())) return { warning: IMAGE_URL_WARNING };
			return parseStringImage(url, mediaType);
		}
		case "text": return fileData.text ? { text: fileData.text } : {};
		case "reference": return { warning: FILE_REFERENCE_WARNING };
		default: return { warning: createUnknownPromptVariantWarning(fileData, "prompt file data") };
	}
}
function serializeToolResultFilePart(part, warnings) {
	const fileData = part.data;
	const fileLabel = part.filename ? `File ${part.filename}` : "File";
	switch (fileData.type) {
		case "data": return `[${fileLabel}: ${part.mediaType}]`;
		case "url": return `[${fileLabel}: ${part.mediaType}: ${fileData.url.toString()}]`;
		case "text": return fileData.text;
		case "reference":
			warnings.push(FILE_REFERENCE_WARNING);
			return;
		default: {
			const unknownFileData = fileData;
			warnings.push(createUnknownPromptVariantWarning(unknownFileData, "tool result file data"));
			return;
		}
	}
}
function serializeToolResultContentPart(part, warnings) {
	switch (part.type) {
		case "text": return part.text;
		case "file": return serializeToolResultFilePart(part, warnings);
		case "custom": return;
		default: {
			const unknownPart = part;
			warnings.push(createUnknownPromptVariantWarning(unknownPart, "tool result content part"));
			return;
		}
	}
}
function serializeToolResultOutput(output, warnings) {
	switch (output.type) {
		case "text":
		case "error-text": return output.value;
		case "json":
		case "error-json": return JSON.stringify(output.value) ?? String(output.value);
		case "execution-denied": return `[Execution denied${output.reason ? `: ${output.reason}` : ""}]`;
		case "content": return output.value.map((part) => serializeToolResultContentPart(part, warnings)).filter((text) => typeof text === "string" && text.length > 0).join("\n");
		default: {
			const unknownOutput = output;
			warnings.push(createUnknownPromptVariantWarning(unknownOutput, "tool result output"));
			return;
		}
	}
}
function convertToClaudeCodeMessages(prompt) {
	const messages = [];
	const warnings = [];
	let systemPrompt;
	const streamingSegments = [];
	const imageMap = /* @__PURE__ */ new Map();
	let hasImageParts = false;
	const addSegment = (formatted) => {
		streamingSegments.push({ formatted });
		return streamingSegments.length - 1;
	};
	const addImageForSegment = (segmentIndex, content) => {
		hasImageParts = true;
		if (!imageMap.has(segmentIndex)) imageMap.set(segmentIndex, []);
		imageMap.get(segmentIndex)?.push(content);
	};
	const addWarning = (warning) => {
		if (warning) warnings.push(warning);
	};
	for (const message of prompt) switch (message.role) {
		case "system":
			systemPrompt = systemPrompt === void 0 ? message.content : `${systemPrompt}

${message.content}`;
			if (message.content.trim().length > 0) addSegment(message.content);
			else addSegment("");
			break;
		case "user": {
			const textParts = [];
			const imageParts = [];
			for (const part of message.content) switch (part.type) {
				case "text":
					if (typeof part.text === "string") textParts.push(part.text);
					break;
				case "file": {
					const { content, text, warning } = parseFilePart(part);
					if (typeof text === "string") textParts.push(text);
					if (content) imageParts.push(content);
					addWarning(warning);
					break;
				}
				default: addWarning(createUnknownPromptVariantWarning(part, "prompt user content part"));
			}
			const textContent = textParts.join("\n");
			const segmentIndex = addSegment(textContent ? `Human: ${textContent}` : "");
			if (textContent) messages.push(`Human: ${textContent}`);
			for (const imagePart of imageParts) addImageForSegment(segmentIndex, imagePart);
			break;
		}
		case "assistant": {
			const assistantParts = [];
			const imageParts = [];
			for (const part of message.content) switch (part.type) {
				case "text":
					if (typeof part.text === "string") assistantParts.push(part.text);
					break;
				case "tool-call":
					assistantParts.push(`[Tool call: ${part.toolName}(${serializeToolCallInput(part.input)})]`);
					break;
				case "tool-result": {
					const output = serializeToolResultOutput(part.output, warnings);
					if (output !== void 0) assistantParts.push(`Tool Result (${part.toolName}): ${output}`);
					break;
				}
				case "file": {
					const { content, text, warning } = parseFilePart(part);
					if (typeof text === "string") assistantParts.push(text);
					if (content) imageParts.push(content);
					addWarning(warning);
					break;
				}
				case "reasoning": break;
				case "reasoning-file": break;
				case "custom": break;
				default: addWarning(createUnknownPromptVariantWarning(part, "prompt assistant content part"));
			}
			const formattedAssistant = `Assistant: ${assistantParts.join("\n")}`;
			messages.push(formattedAssistant);
			const segmentIndex = addSegment(formattedAssistant);
			for (const imagePart of imageParts) addImageForSegment(segmentIndex, imagePart);
			break;
		}
		case "tool":
			for (const tool3 of message.content) switch (tool3.type) {
				case "tool-result": {
					const output = serializeToolResultOutput(tool3.output, warnings);
					if (output !== void 0) {
						const formattedToolResult = `Tool Result (${tool3.toolName}): ${output}`;
						messages.push(formattedToolResult);
						addSegment(formattedToolResult);
					}
					break;
				}
				case "tool-approval-response": break;
				default: addWarning(createUnknownPromptVariantWarning(tool3, "prompt tool content part"));
			}
			break;
		default: addWarning(createUnknownPromptVariantWarning(message, "prompt message", "role"));
	}
	let finalPrompt = "";
	if (systemPrompt) finalPrompt = systemPrompt;
	if (messages.length > 0) {
		const formattedMessages = [];
		for (let i = 0; i < messages.length; i++) formattedMessages.push(messages[i]);
		if (finalPrompt) {
			const joinedMessages = formattedMessages.join("\n\n");
			finalPrompt = joinedMessages ? `${finalPrompt}

${joinedMessages}` : finalPrompt;
		} else finalPrompt = formattedMessages.join("\n\n");
	}
	const streamingParts = [];
	const imagePartsInOrder = [];
	const appendImagesForIndex = (index) => {
		const images = imageMap.get(index);
		if (!images) return;
		images.forEach((image) => {
			streamingParts.push(image);
			imagePartsInOrder.push(image);
		});
	};
	if (streamingSegments.length > 0) {
		let accumulatedText = "";
		let emittedText = false;
		const flushText = () => {
			if (!accumulatedText) return;
			streamingParts.push({
				type: "text",
				text: accumulatedText
			});
			accumulatedText = "";
			emittedText = true;
		};
		streamingSegments.forEach((segment, index) => {
			const segmentText = segment.formatted;
			if (segmentText) {
				if (!accumulatedText) accumulatedText = emittedText ? `

${segmentText}` : segmentText;
				else accumulatedText += `

${segmentText}`;
			}
			if (imageMap.has(index)) {
				flushText();
				appendImagesForIndex(index);
			}
		});
		flushText();
	}
	return {
		messagesPrompt: finalPrompt,
		systemPrompt,
		...warnings.length > 0 && { warnings },
		streamingContentParts: streamingParts.length > 0 ? streamingParts : [{
			type: "text",
			text: finalPrompt
		}, ...imagePartsInOrder],
		hasImageParts
	};
}
var STDERR_TAIL_MARKER = " | stderr (tail):";
var ANSI_ESCAPE_SEQUENCE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g;
function stderrTail(raw) {
	const withoutAnsi = raw.replace(ANSI_ESCAPE_SEQUENCE, "");
	const tail = Array.from(withoutAnsi).filter((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return character === "\r" || character === "\n" || codePoint === 8232 || codePoint === 8233 || codePoint >= 32 && codePoint < 127 || codePoint > 159;
	}).join("").split(/\r\n|\r|\n|\u2028|\u2029/).map((line) => line.trim()).filter((line) => line.length > 0).slice(-5).join("; ");
	const codePoints = Array.from(tail);
	return codePoints.length > 600 ? `\u2026${codePoints.slice(-599).join("")}` : tail;
}
function createAPICallError({ message, code, exitCode, stderr, promptExcerpt, isRetryable = false }) {
	const metadata = {
		code,
		exitCode,
		stderr,
		promptExcerpt
	};
	const tail = typeof stderr === "string" && stderr.length > 0 ? stderrTail(stderr) : "";
	const enrichedMessage = tail && !message.includes(STDERR_TAIL_MARKER) ? `${message}${STDERR_TAIL_MARKER} ${tail}` : message;
	return new APICallError({
		message: enrichedMessage,
		isRetryable,
		url: "claude-code-cli://command",
		requestBodyValues: promptExcerpt ? { prompt: promptExcerpt } : void 0,
		data: metadata
	});
}
function createAuthenticationError({ message, stderr }) {
	const error = new LoadAPIKeyError({ message: message || "Authentication failed. Please ensure Claude Code SDK is properly authenticated." });
	if (stderr) error.data = { stderr };
	return error;
}
function createTimeoutError({ message, stderr, promptExcerpt, timeoutMs }) {
	const metadata = {
		code: "TIMEOUT",
		stderr,
		promptExcerpt
	};
	return new APICallError({
		message,
		isRetryable: true,
		url: "claude-code-cli://command",
		requestBodyValues: promptExcerpt ? { prompt: promptExcerpt } : void 0,
		data: timeoutMs !== void 0 ? {
			...metadata,
			timeoutMs
		} : metadata
	});
}
function mapClaudeCodeFinishReason(subtype, stopReason) {
	if (stopReason != null) switch (stopReason) {
		case "end_turn": return {
			unified: "stop",
			raw: "end_turn"
		};
		case "max_tokens": return {
			unified: "length",
			raw: "max_tokens"
		};
		case "stop_sequence": return {
			unified: "stop",
			raw: "stop_sequence"
		};
		case "tool_use": return {
			unified: "tool-calls",
			raw: "tool_use"
		};
	}
	const raw = stopReason ?? subtype;
	switch (subtype) {
		case "success": return {
			unified: "stop",
			raw
		};
		case "error_max_turns": return {
			unified: "length",
			raw
		};
		case "error_during_execution": return {
			unified: "error",
			raw
		};
		case void 0: return {
			unified: "stop",
			raw
		};
		default: return {
			unified: "other",
			raw
		};
	}
}
function isBlankResume(value) {
	return typeof value === "string" && value.trim() === "";
}
var loggerFunctionSchema = object({
	debug: any().refine((val) => typeof val === "function", { message: "debug must be a function" }),
	info: any().refine((val) => typeof val === "function", { message: "info must be a function" }),
	warn: any().refine((val) => typeof val === "function", { message: "warn must be a function" }),
	error: any().refine((val) => typeof val === "function", { message: "error must be a function" })
});
var claudeCodeSettingsSchema = object({
	pathToClaudeCodeExecutable: string().optional(),
	customSystemPrompt: string().optional(),
	appendSystemPrompt: string().optional(),
	systemPrompt: union([
		string(),
		array(string()),
		object({
			type: literal("preset"),
			preset: literal("claude_code"),
			append: string().optional(),
			excludeDynamicSections: boolean().optional()
		})
	]).optional(),
	maxTurns: number().int().min(1).max(100).optional(),
	maxThinkingTokens: number().int().positive().max(1e5).optional(),
	thinking: union([
		object({
			type: literal("adaptive"),
			display: _enum(["summarized", "omitted"]).optional()
		}).strict(),
		object({
			type: literal("enabled"),
			budgetTokens: number().int().positive().optional(),
			display: _enum(["summarized", "omitted"]).optional()
		}).strict(),
		object({ type: literal("disabled") }).strict()
	]).optional(),
	effort: _enum([
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	]).optional(),
	promptSuggestions: boolean().optional(),
	cwd: string().refine((val) => {
		if (typeof process === "undefined" || !process.versions?.node) return true;
		return !val || existsSync(val);
	}, { message: "Working directory must exist" }).optional(),
	executable: _enum([
		"bun",
		"deno",
		"node"
	]).optional(),
	executableArgs: array(string()).optional(),
	permissionMode: _enum([
		"default",
		"acceptEdits",
		"bypassPermissions",
		"plan",
		"dontAsk",
		"auto"
	]).optional(),
	permissionPromptToolName: string().optional(),
	continue: boolean().optional(),
	resume: string().optional(),
	sessionId: string().refine((val) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(val), { message: "sessionId must be a valid UUID (the CLI rejects non-UUID session IDs)" }).optional(),
	allowedTools: array(string()).optional(),
	disallowedTools: array(string()).optional(),
	betas: array(string()).optional(),
	allowDangerouslySkipPermissions: boolean().optional(),
	enableFileCheckpointing: boolean().optional(),
	maxBudgetUsd: number().min(0).optional(),
	plugins: array(object({
		type: literal("local"),
		path: string()
	}).passthrough()).optional(),
	resumeSessionAt: string().optional(),
	resumeDropsTurn: string().optional(),
	sandbox: any().refine((val) => val === void 0 || typeof val === "object", { message: "sandbox must be an object" }).optional(),
	tools: union([array(string()), object({
		type: literal("preset"),
		preset: literal("claude_code")
	})]).optional(),
	skills: union([array(string()), literal("all")]).optional(),
	settings: union([string(), record(string(), any())]).optional(),
	managedSettings: record(string(), any()).optional(),
	toolAliases: record(string(), string()).optional(),
	toolConfig: object({ askUserQuestion: object({ previewFormat: _enum(["markdown", "html"]).optional() }).passthrough().optional() }).passthrough().optional(),
	planModeInstructions: string().optional(),
	title: string().optional(),
	forwardSubagentText: boolean().optional(),
	agentProgressSummaries: boolean().optional(),
	includeHookEvents: boolean().optional(),
	onSdkMessage: any().refine((v) => v === void 0 || typeof v === "function", { message: "onSdkMessage must be a function" }).optional(),
	onTaskEvent: any().refine((v) => v === void 0 || typeof v === "function", { message: "onTaskEvent must be a function" }).optional(),
	onHookEvent: any().refine((v) => v === void 0 || typeof v === "function", { message: "onHookEvent must be a function" }).optional(),
	onMcpStatusChange: any().refine((v) => v === void 0 || typeof v === "function", { message: "onMcpStatusChange must be a function" }).optional(),
	taskBudget: object({ total: number().positive() }).strict().optional(),
	sessionStore: any().refine((val) => val === void 0 || typeof val === "object" && val !== null && typeof val.append === "function" && typeof val.load === "function", { message: "sessionStore must be an object with append() and load() functions" }).optional(),
	sessionStoreFlush: _enum(["batched", "eager"]).optional(),
	loadTimeoutMs: number().int().positive().optional(),
	settingSources: array(_enum([
		"user",
		"project",
		"local"
	])).optional(),
	streamingInput: _enum([
		"auto",
		"always",
		"off"
	]).optional(),
	canUseTool: any().refine((v) => v === void 0 || typeof v === "function", { message: "canUseTool must be a function" }).optional(),
	onUserDialog: any().refine((v) => v === void 0 || typeof v === "function", { message: "onUserDialog must be a function" }).optional(),
	onElicitation: any().refine((v) => v === void 0 || typeof v === "function", { message: "onElicitation must be a function" }).optional(),
	supportedDialogKinds: array(string()).optional(),
	hooks: record(string(), array(object({
		matcher: string().optional(),
		hooks: array(any()).nonempty()
	}))).optional(),
	mcpServers: record(string(), union([
		object({
			type: literal("stdio").optional(),
			command: string(),
			args: array(string()).optional(),
			env: record(string(), string()).optional()
		}),
		object({
			type: literal("sse"),
			url: string(),
			headers: record(string(), string()).optional()
		}),
		object({
			type: literal("http"),
			url: string(),
			headers: record(string(), string()).optional()
		}),
		object({
			type: literal("sdk"),
			name: string(),
			instance: any()
		})
	])).optional(),
	verbose: boolean().optional(),
	debug: boolean().optional(),
	debugFile: string().optional(),
	logger: union([literal(false), loggerFunctionSchema]).optional(),
	env: record(string(), string().optional()).optional(),
	additionalDirectories: array(string()).optional(),
	agent: string().optional(),
	agents: record(string(), object({
		description: string(),
		tools: array(string()).optional(),
		disallowedTools: array(string()).optional(),
		prompt: string(),
		model: string().optional(),
		mcpServers: array(union([string(), record(string(), any())])).optional(),
		criticalSystemReminder_EXPERIMENTAL: string().optional()
	}).passthrough()).optional(),
	includePartialMessages: boolean().optional(),
	fallbackModel: string().optional(),
	forkSession: boolean().optional(),
	stderr: any().refine((val) => val === void 0 || typeof val === "function", { message: "stderr must be a function" }).optional(),
	strictMcpConfig: boolean().optional(),
	extraArgs: record(string(), union([string(), _null()])).optional(),
	persistSession: boolean().optional(),
	spawnClaudeCodeProcess: any().refine((val) => val === void 0 || typeof val === "function", { message: "spawnClaudeCodeProcess must be a function" }).optional(),
	sdkOptions: record(string(), any()).optional(),
	maxToolResultSize: number().int().min(100).max(1e6).optional(),
	onQueryCreated: any().refine((val) => val === void 0 || typeof val === "function", { message: "onQueryCreated must be a function" }).optional(),
	onQueryControllerCreated: any().refine((val) => val === void 0 || typeof val === "function", { message: "onQueryControllerCreated must be a function" }).optional(),
	onStreamStart: any().refine((val) => val === void 0 || typeof val === "function", { message: "onStreamStart must be a function" }).optional(),
	onPromptSuggestion: any().refine((val) => val === void 0 || typeof val === "function", { message: "onPromptSuggestion must be a function" }).optional()
}).strict();
function validateModelId(modelId) {
	const knownModels = [
		"opus",
		"sonnet",
		"haiku",
		"fable"
	];
	if (!modelId || modelId.trim() === "") throw new Error("Model ID cannot be empty");
	if (!knownModels.includes(modelId)) return `Unknown model ID: '${modelId}'. Proceeding with custom model. Known models are: ${knownModels.join(", ")}`;
}
function validateSettings(settings) {
	const warnings = [];
	const errors = [];
	try {
		const result = claudeCodeSettingsSchema.safeParse(settings);
		if (!result.success) {
			const errorObject = result.error;
			(errorObject.errors || errorObject.issues || []).forEach((err) => {
				const path = err.path.join(".");
				errors.push(`${path ? `${path}: ` : ""}${err.message}`);
			});
			return {
				valid: false,
				warnings,
				errors
			};
		}
		const validSettings = result.data;
		const sdkOptionsRecord = validSettings.sdkOptions;
		const effective = (key) => {
			const override = sdkOptionsRecord?.[key];
			return override !== void 0 ? override : validSettings[key];
		};
		const effSessionStore = effective("sessionStore");
		const effectiveResumeId = () => {
			for (const candidate of [sdkOptionsRecord?.resume, validSettings.resume]) if (typeof candidate === "string" && !isBlankResume(candidate)) return candidate;
		};
		if (effSessionStore !== void 0 && effective("persistSession") === false) {
			errors.push("sessionStore cannot be combined with persistSession: false. Transcript mirroring requires local session writes; remove persistSession: false or drop sessionStore.");
			return {
				valid: false,
				warnings,
				errors
			};
		}
		if (effSessionStore !== void 0 && effective("enableFileCheckpointing") === true) {
			errors.push("sessionStore cannot be combined with enableFileCheckpointing: true. Checkpoint backup blobs are not mirrored to the store (rewindFiles() fails after a store-backed resume); remove enableFileCheckpointing or drop sessionStore.");
			return {
				valid: false,
				warnings,
				errors
			};
		}
		if (effective("continue") === true && effSessionStore !== void 0 && effectiveResumeId() === void 0 && typeof effSessionStore.listSessions !== "function") {
			errors.push("continue: true with sessionStore requires the store to implement listSessions() (used to discover the most recent session). Implement listSessions(), pass resume with an explicit session ID, or drop continue.");
			return {
				valid: false,
				warnings,
				errors
			};
		}
		const effSettingsOption = effective("settings");
		if (effective("sandbox") !== void 0 && typeof effSettingsOption === "string" && !(effSettingsOption.trim().startsWith("{") && effSettingsOption.trim().endsWith("}"))) {
			errors.push("sandbox cannot be combined with a settings file path. Pass settings as an inline Settings object, or move the sandbox configuration into the settings file and drop the sandbox option.");
			return {
				valid: false,
				warnings,
				errors
			};
		}
		if (effective("sessionId") !== void 0 && effective("forkSession") !== true && (effective("continue") === true || effectiveResumeId() !== void 0)) {
			errors.push("sessionId cannot be combined with continue or resume unless forkSession: true is also set (it then names the forked session's ID). Remove sessionId, remove continue/resume, or add forkSession: true.");
			return {
				valid: false,
				warnings,
				errors
			};
		}
		if (validSettings.maxTurns && validSettings.maxTurns > 20) warnings.push(`High maxTurns value (${validSettings.maxTurns}) may lead to long-running conversations`);
		if (validSettings.maxThinkingTokens && validSettings.maxThinkingTokens > 5e4) warnings.push(`Very high maxThinkingTokens (${validSettings.maxThinkingTokens}) may increase response time`);
		if (validSettings.onPromptSuggestion !== void 0 && effective("promptSuggestions") !== true) warnings.push("onPromptSuggestion is registered but promptSuggestions is not enabled. The CLI only emits prompt_suggestion messages when promptSuggestions is true, so the callback will never fire. Set promptSuggestions: true.");
		if (validSettings.allowedTools && validSettings.disallowedTools) warnings.push("Both allowedTools and disallowedTools are specified. Only allowedTools will be used.");
		const validateToolNames = (tools, type) => {
			tools.forEach((tool3) => {
				if (!/^[a-zA-Z_][a-zA-Z0-9_]*(\([^)]*\))?$/.test(tool3) && !tool3.startsWith("mcp__")) warnings.push(`Unusual ${type} tool name format: '${tool3}'`);
			});
		};
		if (validSettings.allowedTools) validateToolNames(validSettings.allowedTools, "allowed");
		if (validSettings.disallowedTools) validateToolNames(validSettings.disallowedTools, "disallowed");
		const effDialogKinds = effective("supportedDialogKinds");
		if (Array.isArray(effDialogKinds) && effDialogKinds.length > 0 && effective("onUserDialog") == null) {
			errors.push("supportedDialogKinds is set without onUserDialog. The SDK requires the onUserDialog callback to render declared dialog kinds and throws when a non-empty list is passed without it; provide onUserDialog or remove supportedDialogKinds.");
			return {
				valid: false,
				warnings,
				errors
			};
		}
		const effAllowedTools = effective("allowedTools");
		if (Array.isArray(effAllowedTools) && effAllowedTools.includes("Skill") && !effective("settingSources")) warnings.push("allowedTools includes 'Skill' but settingSources is not set. Skills require settingSources (e.g., ['user', 'project']) to load skill definitions.");
		if (validSettings.agents) {
			const knownAgentModelAliases = [
				"sonnet",
				"opus",
				"haiku",
				"fable",
				"inherit"
			];
			for (const [agentName, agent] of Object.entries(validSettings.agents)) {
				const agentModel = agent.model;
				if (agentModel !== void 0 && !knownAgentModelAliases.includes(agentModel) && !agentModel.includes("-")) warnings.push(`Unknown model alias '${agentModel}' for agent '${agentName}'. Known aliases are: ${knownAgentModelAliases.join(", ")}; full model IDs (e.g. 'claude-sonnet-4-5') are also accepted.`);
			}
		}
		return {
			valid: true,
			warnings,
			errors
		};
	} catch (error) {
		errors.push(`Validation error: ${error instanceof Error ? error.message : String(error)}`);
		return {
			valid: false,
			warnings,
			errors
		};
	}
}
function validatePrompt(prompt) {
	if (prompt.length > 1e5) return `Very long prompt (${prompt.length} characters) may cause performance issues or timeouts`;
}
function validateSessionId(sessionId) {
	if (sessionId && !/^[a-zA-Z0-9-_]+$/.test(sessionId)) return `Unusual session ID format. This may cause issues with session resumption.`;
}
var SUBSCHEMA_MAP_KEYWORDS = [
	"properties",
	"patternProperties",
	"$defs",
	"definitions",
	"dependentSchemas",
	"dependencies"
];
var SUBSCHEMA_KEYWORDS = [
	"items",
	"additionalItems",
	"additionalProperties",
	"unevaluatedItems",
	"unevaluatedProperties",
	"not",
	"contains",
	"propertyNames",
	"contentSchema",
	"if",
	"then",
	"else"
];
var SUBSCHEMA_LIST_KEYWORDS = [
	"prefixItems",
	"anyOf",
	"oneOf",
	"allOf"
];
function sanitizeJsonSchemaForOutputFormat(schema) {
	const strippedFormatPaths = [];
	return {
		schema: sanitizeNode(schema, "#", /* @__PURE__ */ new WeakSet(), strippedFormatPaths) ?? schema,
		strippedFormatPaths
	};
}
function sanitizeNode(node, path, visiting, strippedFormatPaths) {
	if (typeof node !== "object" || node === null) return node;
	if (visiting.has(node)) return node;
	visiting.add(node);
	try {
		if (Array.isArray(node)) return sanitizeList(node, path, visiting, strippedFormatPaths);
		const record = node;
		let result = record;
		const setKey = (key, value) => {
			if (result === record) result = { ...record };
			result[key] = value;
		};
		if (typeof record.format === "string") {
			const format = record.format;
			const existingDescription = record.description;
			result = { ...record };
			delete result.format;
			if (typeof existingDescription === "string" && existingDescription.length > 0) result.description = `${existingDescription} (expected format: ${format})`;
			else if (existingDescription === void 0 || existingDescription === "") result.description = `Expected format: ${format}`;
			strippedFormatPaths.push(path);
		}
		for (const keyword of SUBSCHEMA_MAP_KEYWORDS) {
			const map = record[keyword];
			if (typeof map !== "object" || map === null || Array.isArray(map)) continue;
			const mapRecord = map;
			let newMap = mapRecord;
			for (const [name, child] of Object.entries(mapRecord)) {
				const sanitizedChild = sanitizeNode(child, `${path}/${keyword}/${name}`, visiting, strippedFormatPaths);
				if (sanitizedChild !== child) {
					if (newMap === mapRecord) newMap = { ...mapRecord };
					newMap[name] = sanitizedChild;
				}
			}
			if (newMap !== mapRecord) setKey(keyword, newMap);
		}
		for (const keyword of SUBSCHEMA_KEYWORDS) {
			const child = record[keyword];
			if (typeof child !== "object" || child === null) continue;
			const sanitizedChild = sanitizeNode(child, `${path}/${keyword}`, visiting, strippedFormatPaths);
			if (sanitizedChild !== child) setKey(keyword, sanitizedChild);
		}
		for (const keyword of SUBSCHEMA_LIST_KEYWORDS) {
			const list = record[keyword];
			if (!Array.isArray(list)) continue;
			const sanitizedList = sanitizeList(list, `${path}/${keyword}`, visiting, strippedFormatPaths);
			if (sanitizedList !== list) setKey(keyword, sanitizedList);
		}
		return result;
	} finally {
		visiting.delete(node);
	}
}
function sanitizeList(list, path, visiting, strippedFormatPaths) {
	let result = list;
	for (let i = 0; i < list.length; i++) {
		const sanitizedChild = sanitizeNode(list[i], `${path}/${i}`, visiting, strippedFormatPaths);
		if (sanitizedChild !== list[i]) {
			if (result === list) result = [...list];
			result[i] = sanitizedChild;
		}
	}
	return result;
}
var defaultLogger = {
	debug: (message) => console.debug(`[DEBUG] ${message}`),
	info: (message) => console.info(`[INFO] ${message}`),
	warn: (message) => console.warn(`[WARN] ${message}`),
	error: (message) => console.error(`[ERROR] ${message}`)
};
var noopLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {}
};
function getLogger(logger) {
	if (logger === false) return noopLogger;
	if (logger === void 0) return defaultLogger;
	return logger;
}
function createVerboseLogger(logger, verbose = false) {
	if (verbose) return logger;
	return {
		debug: () => {},
		info: () => {},
		warn: logger.warn.bind(logger),
		error: logger.error.bind(logger)
	};
}
function createClaudeCodeQueryController(query2) {
	const controller = {
		rawQuery: query2,
		interrupt: async () => {
			await query2.interrupt();
		},
		setPermissionMode: (mode) => query2.setPermissionMode(mode),
		setMcpPermissionModeOverride: (serverName, mode) => query2.setMcpPermissionModeOverride(serverName, mode),
		setModel: (model) => query2.setModel(model),
		setMaxThinkingTokens: (maxThinkingTokens, thinkingDisplay) => query2.setMaxThinkingTokens(maxThinkingTokens, thinkingDisplay),
		applyFlagSettings: (settings) => query2.applyFlagSettings(settings),
		mcpServerStatus: () => query2.mcpServerStatus(),
		reconnectMcpServer: (serverName) => query2.reconnectMcpServer(serverName),
		toggleMcpServer: (serverName, enabled) => query2.toggleMcpServer(serverName, enabled),
		setMcpServers: (servers) => query2.setMcpServers(servers),
		getContextUsage: () => query2.getContextUsage(),
		rewindFiles: (userMessageId, options) => query2.rewindFiles(userMessageId, options),
		stopTask: (taskId) => query2.stopTask(taskId),
		backgroundTasks: (toolUseId) => toolUseId === void 0 ? query2.backgroundTasks() : query2.backgroundTasks(toolUseId)
	};
	const streamInput = query2.streamInput;
	if (typeof streamInput === "function") controller.streamInput = (stream) => streamInput.call(query2, stream);
	return controller;
}
var DEFAULT_CLIENT_APP = `ai-sdk-provider-claude-code/4.1.1`;
var CLAUDE_CODE_TRUNCATION_WARNING = "Claude Code SDK output ended unexpectedly; returning truncated response from buffered text. Await upstream fix to avoid data loss.";
var MIN_TRUNCATION_LENGTH = 512;
function capStderr(raw) {
	if (raw.length <= 4e3) return raw;
	return Array.from(raw).slice(-4e3).join("");
}
function isClaudeCodeTruncationError(error, bufferedText) {
	if (!(error instanceof SyntaxError || typeof error?.name === "string" && error.name.toLowerCase() === "syntaxerror")) return false;
	if (!bufferedText) return false;
	const message = (typeof error?.message === "string" ? error.message : "").toLowerCase();
	if (![
		"unexpected end of json input",
		"unexpected end of input",
		"unexpected end of string",
		"unexpected eof",
		"end of file",
		"unterminated string",
		"unterminated string constant"
	].some((indicator) => message.includes(indicator))) return false;
	if (bufferedText.length < MIN_TRUNCATION_LENGTH) return false;
	return true;
}
var MISSING_STRUCTURED_OUTPUT_ERROR_MESSAGE = "Structured output was requested (responseFormat with a JSON schema) but the Claude Code CLI returned no structured_output, and the prose response could not be parsed as JSON. This usually means the schema contains constructs the CLI cannot enforce (e.g. complex regex patterns with lookaheads/backreferences), causing it to silently fall back to prose. Simplify the generation schema and validate strictly client-side. See the 'Structured Outputs' section of the ai-sdk-provider-claude-code README for the list of known limitations.";
var INTERNAL_STRUCTURED_OUTPUT_TOOL_NAME = "StructuredOutput";
function isInternalStructuredOutputTool(toolName, options) {
	return options.responseFormat?.type === "json" && toolName === INTERNAL_STRUCTURED_OUTPUT_TOOL_NAME;
}
function isNonTextToolUseContentBlockType(type) {
	return type === "server_tool_use" || type === "mcp_tool_use";
}
function extractJsonObjectText(text) {
	const trimmed = text.trim();
	if (!trimmed) return;
	const candidates = [trimmed];
	const fencedBlocks = Array.from(trimmed.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/gi)).map((match) => match[1]?.trim()).filter((block) => block !== void 0 && block.length > 0);
	candidates.push(...fencedBlocks.reverse());
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			const parsed = JSON.parse(candidate);
			if (typeof parsed === "object" && parsed !== null) return candidate;
		} catch {}
	}
}
function getStructuredErrorKind(error) {
	if (typeof error === "object" && error !== null && "errorKind" in error) {
		const kind = error.errorKind;
		if (typeof kind === "string") return kind;
	}
}
function isAbortError(err) {
	if (err && typeof err === "object") {
		const e = err;
		if (typeof e.name === "string" && e.name === "AbortError") return true;
		if (typeof e.code === "string" && e.code.toUpperCase() === "ABORT_ERR") return true;
	}
	return false;
}
var DEFAULT_INHERITED_ENV_VARS = process.platform === "win32" ? [
	"APPDATA",
	"COMSPEC",
	"HOMEDRIVE",
	"HOMEPATH",
	"LOCALAPPDATA",
	"PATH",
	"PATHEXT",
	"SYSTEMDRIVE",
	"SYSTEMROOT",
	"TEMP",
	"TMP",
	"USERNAME",
	"USERPROFILE",
	"WINDIR"
] : [
	"HOME",
	"LOGNAME",
	"PATH",
	"SHELL",
	"TERM",
	"USER",
	"LANG",
	"LC_ALL",
	"TMPDIR"
];
var CLAUDE_ENV_VARS = ["CLAUDE_CONFIG_DIR"];
var NETWORK_ENV_VARS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR"
];
var CLOUD_ENV_VARS = ["GCLOUD_PROJECT", "CLOUD_ML_REGION"];
var INHERITED_ENV_PREFIXES = [
	"ANTHROPIC_",
	"CLAUDE_",
	"AWS_",
	"GOOGLE_"
];
function getBaseProcessEnv() {
	const env = {};
	const allowedKeys = /* @__PURE__ */ new Set([
		...DEFAULT_INHERITED_ENV_VARS,
		...CLAUDE_ENV_VARS,
		...NETWORK_ENV_VARS,
		...CLOUD_ENV_VARS
	]);
	const addIfSafe = (key) => {
		const value = process.env[key];
		if (typeof value !== "string") return;
		if (value.startsWith("()")) return;
		env[key] = value;
	};
	for (const key of allowedKeys) addIfSafe(key);
	for (const key of Object.keys(process.env)) if (INHERITED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) addIfSafe(key);
	return env;
}
var STREAMING_FEATURE_WARNING = "Claude Agent SDK image input requires streaming input. Set `streamingInput: 'auto'` or `streamingInput: 'always'`; `streamingInput: 'off'` disables streaming image input.";
var SDK_OPTIONS_BLOCKLIST = /* @__PURE__ */ new Set([
	"model",
	"abortController",
	"prompt",
	"outputFormat"
]);
var SUBAGENT_TOOL_NAMES = /* @__PURE__ */ new Set(["Task", "Agent"]);
function isSubagentToolName(name) {
	return SUBAGENT_TOOL_NAMES.has(name);
}
function resolveToolParentId(messageLevel, blockLevel, inferFallback) {
	if (messageLevel !== void 0) return messageLevel;
	if (typeof blockLevel === "string") return blockLevel;
	return inferFallback();
}
function computeRetractedToolCallIds(retracted, descriptors) {
	const ids = /* @__PURE__ */ new Set();
	for (const { toolCallId, uuid } of descriptors) if (uuid !== void 0 && retracted.has(uuid)) ids.add(toolCallId);
	return ids;
}
function applySupersede(message, evict, logger, guard = "array") {
	const supersedes = message.supersedes;
	if (!(guard === "truthy" ? Boolean(supersedes && supersedes.length > 0) : Array.isArray(supersedes) && supersedes.length > 0) || supersedes === void 0) return false;
	logger.debug(`[claude-code] Assistant message supersedes ${supersedes.length} prior message(s)`);
	evict(new Set(supersedes));
	return true;
}
function buildRetractionEvictor(evict) {
	return (uuids) => evict(new Set(uuids));
}
var INFORMATIONAL_SYSTEM_SUBTYPES = /* @__PURE__ */ new Set([
	"notification",
	"status",
	"session_state_changed",
	"commands_changed",
	"memory_recall",
	"plugin_install",
	"informational"
]);
var CLAUDE_REASONING_EFFORT_MAP = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh"
};
var CLAUDE_EFFORT_LEVELS = /* @__PURE__ */ new Set([
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
]);
function isObjectRecord(value) {
	return typeof value === "object" && value !== null;
}
function toJsonSafeValue(value) {
	if (value === void 0) return;
	try {
		const serialized = JSON.stringify(value);
		return serialized === void 0 ? void 0 : JSON.parse(serialized);
	} catch {
		return String(value);
	}
}
function deepFreezeJsonValue(value) {
	if (Array.isArray(value)) {
		for (const nested of value) deepFreezeJsonValue(nested);
		return Object.freeze(value);
	}
	if (!isObjectRecord(value)) return value;
	const objectValue = value;
	for (const nested of Object.values(objectValue)) if (nested !== void 0) deepFreezeJsonValue(nested);
	return Object.freeze(objectValue);
}
function toJsonSafeClone(value) {
	const clone = toJsonSafeValue(value);
	if (clone === void 0) return;
	return clone;
}
function toImmutableJsonSafeClone(value) {
	const clone = toJsonSafeValue(value);
	if (clone === void 0) return;
	return deepFreezeJsonValue(clone);
}
function hasValidThinkingDisplay(value) {
	return value === void 0 || value === "summarized" || value === "omitted";
}
function isClaudeEffortLevel(value) {
	return typeof value === "string" && CLAUDE_EFFORT_LEVELS.has(value);
}
function isClaudeThinkingConfig(value) {
	if (!isObjectRecord(value)) return false;
	if (value.type === "disabled") return true;
	if (value.type === "adaptive") return hasValidThinkingDisplay(value.display);
	if (value.type === "enabled") {
		const budgetTokens = value.budgetTokens;
		return (budgetTokens === void 0 || typeof budgetTokens === "number") && hasValidThinkingDisplay(value.display);
	}
	return false;
}
function addInvalidClaudeReasoningProviderOptionWarning(warnings, key) {
	warnings?.push({
		type: "other",
		message: `Invalid providerOptions['claude-code'].${key} value was ignored.`
	});
}
function extractClaudeReasoningProviderOptions(providerOptions, warnings) {
	const options = providerOptions?.["claude-code"];
	if (options === void 0) return { hasClaudeReasoningSettings: false };
	const result = { hasClaudeReasoningSettings: false };
	if (options.thinking !== void 0) {
		if (isClaudeThinkingConfig(options.thinking)) {
			result.thinking = options.thinking;
			result.hasClaudeReasoningSettings = true;
		} else addInvalidClaudeReasoningProviderOptionWarning(warnings, "thinking");
	}
	if (options.effort !== void 0) {
		if (isClaudeEffortLevel(options.effort)) {
			result.effort = options.effort;
			result.hasClaudeReasoningSettings = true;
		} else addInvalidClaudeReasoningProviderOptionWarning(warnings, "effort");
	}
	if (options.maxThinkingTokens !== void 0) {
		if (typeof options.maxThinkingTokens === "number") {
			result.maxThinkingTokens = options.maxThinkingTokens;
			result.hasClaudeReasoningSettings = true;
		} else addInvalidClaudeReasoningProviderOptionWarning(warnings, "maxThinkingTokens");
	}
	return result;
}
function isContentBlock(item) {
	return typeof item === "object" && item !== null && "type" in item;
}
function filterContentBlocks(content, type) {
	if (!Array.isArray(content)) return [];
	const blocks = content.filter((item) => isContentBlock(item) && item.type === type);
	const mismatch = blocks.find((b) => b.type !== type);
	if (mismatch) throw new Error(`filterContentBlocks: block type '${mismatch.type}' passed filter for '${type}'`);
	return blocks;
}
function createEmptyUsage() {
	return {
		inputTokens: {
			total: 0,
			noCache: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		outputTokens: {
			total: 0,
			text: void 0,
			reasoning: void 0
		},
		raw: void 0
	};
}
function convertClaudeCodeUsage(usage) {
	const inputTokens = usage.input_tokens ?? 0;
	const outputTokens = usage.output_tokens ?? 0;
	const cacheWrite = usage.cache_creation_input_tokens ?? 0;
	const cacheRead = usage.cache_read_input_tokens ?? 0;
	return {
		inputTokens: {
			total: inputTokens + cacheWrite + cacheRead,
			noCache: inputTokens,
			cacheRead,
			cacheWrite
		},
		outputTokens: {
			total: outputTokens,
			text: void 0,
			reasoning: void 0
		},
		raw: usage
	};
}
function createMessageInjector() {
	const queue = [];
	let closed = false;
	let resolver = null;
	const injector = {
		inject(content, onResult) {
			if (closed) {
				onResult?.(false);
				return;
			}
			const item = {
				content,
				onResult
			};
			if (resolver) {
				const r = resolver;
				resolver = null;
				r(item);
			} else queue.push(item);
		},
		close() {
			closed = true;
			if (resolver && queue.length === 0) {
				resolver(null);
				resolver = null;
			}
		}
	};
	const getNextItem = () => {
		if (queue.length > 0) {
			const item = queue.shift();
			if (!item) return Promise.resolve(null);
			return Promise.resolve(item);
		}
		if (closed) return Promise.resolve(null);
		return new Promise((resolve) => {
			resolver = (item) => {
				resolve(item);
			};
		});
	};
	const notifySessionEnded = () => {
		for (const item of queue) item.onResult?.(false);
		queue.length = 0;
		closed = true;
		if (resolver) {
			resolver(null);
			resolver = null;
		}
	};
	return {
		injector,
		getNextItem,
		notifySessionEnded
	};
}
function toAsyncIterablePrompt(messagesPrompt, outputStreamEnded, sessionId, contentParts, onStreamStart) {
	const initialMsg = {
		type: "user",
		message: {
			role: "user",
			content: contentParts && contentParts.length > 0 ? contentParts : [{
				type: "text",
				text: messagesPrompt
			}]
		},
		parent_tool_use_id: null,
		session_id: sessionId ?? ""
	};
	if (!onStreamStart) return { async *[Symbol.asyncIterator]() {
		yield initialMsg;
		await outputStreamEnded;
	} };
	const { injector, getNextItem, notifySessionEnded } = createMessageInjector();
	return { async *[Symbol.asyncIterator]() {
		yield initialMsg;
		onStreamStart(injector);
		let streamEnded = false;
		outputStreamEnded.then(() => {
			streamEnded = true;
			notifySessionEnded();
		});
		while (!streamEnded) {
			const item = await Promise.race([getNextItem(), outputStreamEnded.then(() => null)]);
			if (item === null) {
				await outputStreamEnded;
				break;
			}
			yield {
				type: "user",
				message: {
					role: "user",
					content: [{
						type: "text",
						text: item.content
					}]
				},
				parent_tool_use_id: null,
				session_id: sessionId ?? ""
			};
			item.onResult?.(true);
		}
	} };
}
var modelMap = {
	fable: "fable",
	opus: "opus",
	sonnet: "sonnet",
	haiku: "haiku"
};
var MAX_TOOL_RESULT_SIZE = 1e4;
function truncateToolResultForStream(result, maxSize = MAX_TOOL_RESULT_SIZE) {
	if (typeof result === "string") {
		if (result.length <= maxSize) return result;
		return result.slice(0, maxSize) + `
...[truncated ${result.length - maxSize} chars]`;
	}
	if (typeof result !== "object" || result === null) return result;
	if (Array.isArray(result)) {
		let largestIndex = -1;
		let largestSize2 = 0;
		for (let i = 0; i < result.length; i++) {
			const value = result[i];
			if (typeof value === "string" && value.length > largestSize2) {
				largestIndex = i;
				largestSize2 = value.length;
			}
		}
		if (largestIndex >= 0 && largestSize2 > maxSize) {
			const truncatedValue = result[largestIndex].slice(0, maxSize) + `
...[truncated ${largestSize2 - maxSize} chars]`;
			const cloned = [...result];
			cloned[largestIndex] = truncatedValue;
			return cloned;
		}
		return result;
	}
	const obj = result;
	let largestKey = null;
	let largestSize = 0;
	for (const [key, value] of Object.entries(obj)) if (typeof value === "string" && value.length > largestSize) {
		largestKey = key;
		largestSize = value.length;
	}
	if (largestKey && largestSize > maxSize) {
		const truncatedValue = obj[largestKey].slice(0, maxSize) + `
...[truncated ${largestSize - maxSize} chars]`;
		return {
			...obj,
			[largestKey]: truncatedValue
		};
	}
	return result;
}
var ClaudeCodeLanguageModel = class _ClaudeCodeLanguageModel {
	specificationVersion = "v4";
	defaultObjectGenerationMode = "json";
	supportsImageUrls = false;
	supportedUrls = {};
	supportsStructuredOutputs = true;
	static UNKNOWN_TOOL_NAME = "unknown-tool";
	static MAX_TOOL_INPUT_SIZE = 1048576;
	static MAX_TOOL_INPUT_WARN = 102400;
	static MAX_DELTA_CALC_SIZE = 1e4;
	static PROMPT_SUGGESTION_DRAIN_TIMEOUT_MS = 1e4;
	modelId;
	settings;
	sessionId;
	modelValidationWarning;
	settingsValidationWarnings;
	logger;
	constructor(options) {
		this.modelId = options.id;
		this.settings = options.settings ?? {};
		this.settingsValidationWarnings = options.settingsValidationWarnings ?? [];
		const baseLogger = getLogger(this.settings.logger);
		this.logger = createVerboseLogger(baseLogger, this.settings.verbose ?? false);
		if (!this.modelId || typeof this.modelId !== "string" || this.modelId.trim() === "") throw new NoSuchModelError({
			modelId: this.modelId,
			modelType: "languageModel"
		});
		this.modelValidationWarning = validateModelId(this.modelId);
		if (this.modelValidationWarning) this.logger.warn(`Claude Code Model: ${this.modelValidationWarning}`);
	}
	get provider() {
		return "claude-code";
	}
	getModel() {
		return modelMap[this.modelId] ?? this.modelId;
	}
	getSanitizedSdkOptions() {
		if (!this.settings.sdkOptions || typeof this.settings.sdkOptions !== "object") return;
		const sanitized = { ...this.settings.sdkOptions };
		const blockedKeys = Array.from(SDK_OPTIONS_BLOCKLIST).filter((key) => key in sanitized);
		if (blockedKeys.length > 0) {
			this.logger.warn(`[claude-code] sdkOptions includes provider-managed fields (${blockedKeys.join(", ")}); these will be ignored.`);
			blockedKeys.forEach((key) => delete sanitized[key]);
		}
		return sanitized;
	}
	getEffectiveResume(sdkOptions) {
		for (const candidate of [
			sdkOptions?.resume,
			this.settings.resume,
			this.sessionId
		]) if (typeof candidate === "string" && !isBlankResume(candidate)) return candidate;
	}
	invokeObservabilityCallback(callbackName, callback, value) {
		if (!callback) return;
		const logError = (error) => {
			const message = error instanceof Error ? error.message : String(error);
			this.logger.warn(`[claude-code] ${callbackName} callback failed; ignoring error: ${message}`);
			if (error instanceof Error && error.stack) this.logger.debug(`[claude-code] ${callbackName} callback stack: ${error.stack}`);
		};
		try {
			const result = callback(value);
			if (result && typeof result.then === "function") Promise.resolve(result).catch(logError);
		} catch (error) {
			logError(error);
		}
	}
	invokeSdkMessageCallback(message) {
		const onSdkMessage = this.settings.onSdkMessage;
		if (onSdkMessage === void 0) return;
		this.invokeObservabilityCallback("onSdkMessage", onSdkMessage, toImmutableJsonSafeClone(message));
	}
	notifyQueryCreated(response) {
		this.settings.onQueryCreated?.(response);
		const onQueryControllerCreated = this.settings.onQueryControllerCreated;
		if (onQueryControllerCreated !== void 0) this.invokeObservabilityCallback("onQueryControllerCreated", onQueryControllerCreated, createClaudeCodeQueryController(response));
	}
	trackTaskEvent(event, tracking) {
		tracking.taskEvents.push(toJsonSafeClone(event));
		const onTaskEvent = this.settings.onTaskEvent;
		if (onTaskEvent !== void 0) this.invokeObservabilityCallback("onTaskEvent", onTaskEvent, toImmutableJsonSafeClone(event));
	}
	trackHookEvent(event, tracking) {
		tracking.hookEvents.push(toJsonSafeClone(event));
		const onHookEvent = this.settings.onHookEvent;
		if (onHookEvent !== void 0) this.invokeObservabilityCallback("onHookEvent", onHookEvent, toImmutableJsonSafeClone(event));
	}
	trackMcpStatusFromInit(message, tracking) {
		const servers = message.mcp_servers;
		tracking.mcpServers = toJsonSafeClone(servers);
		const statusEvent = {
			subtype: "init",
			sessionId: message.session_id,
			uuid: message.uuid,
			servers,
			raw: message
		};
		const onMcpStatusChange = this.settings.onMcpStatusChange;
		if (onMcpStatusChange !== void 0) this.invokeObservabilityCallback("onMcpStatusChange", onMcpStatusChange, toImmutableJsonSafeClone(statusEvent));
	}
	/**
	* Single source of truth for the CLI's `--session-id` exclusivity rule.
	*
	* The CLI rejects `--session-id` together with `--resume`/`--continue`
	* unless `--fork-session` is also set (forkSession then names the forked
	* session's own ID). This predicate captures "there IS a resume/continue
	* target AND we are not forking", i.e. the case where a session id must NOT
	* coexist. It is referenced by both:
	*   - the pre-merge forwarding guard (via its inverse), which decides whether
	*     to forward `settings.sessionId` onto the base options, and
	*   - the post-merge exclusivity drop, which removes any session id that the
	*     generic sdkOptions overlay (or the auto-resume turn) re-introduced.
	*
	* Keeping one definition guarantees both sites agree on what "conflicts with
	* a session id" means. The mirror in validation.ts (construction-time)
	* intentionally stays separate: it reads settings+sdkOptions, not a built
	* opts object.
	*/
	static sessionIdConflictsWithResumeOrContinue(args) {
		return (args.resumePresent || args.continue) && !args.forkSession;
	}
	/**
	* Owns ALL session-id / resume cross-option resolution on the FINAL merged
	* options, in the single correct order. Called once, immediately after the
	* generic sdkOptions overlay in createQueryOptions.
	*
	* Two concerns, in this exact order (order matters: step 1 can change whether
	* step 2 sees a resume target):
	*
	*  1. Blank-resume restoration. The overlay copies the raw `sdkOptions.resume`
	*     verbatim, which can re-introduce a blank/whitespace value over the
	*     base `resume` that getEffectiveResume already normalized. The SDK treats
	*     a blank resume as absent, so a blank must NOT clobber the computed
	*     fallback — restore `effectiveResume` (already blank-stripped; may itself
	*     be undefined for a genuinely new session) rather than leaving '' or
	*     forcing undefined, which would erase a real settings.resume / captured
	*     session id.
	*
	*  2. Session-id exclusivity. Drop `opts.sessionId` whenever it conflicts with
	*     a resume/continue target (see sessionIdConflictsWithResumeOrContinue).
	*     This runs on the merged opts so it catches a sessionId re-added by the
	*     sdkOptions overlay AND the auto-resumed second turn (where resume was
	*     populated from the captured session id). It complements — does not
	*     replace — the pre-merge forwarding guard, which governs whether
	*     settings.sessionId was forwarded BEFORE the overlay could mutate
	*     forkSession/continue/resume.
	*/
	applySessionResolution(opts, effectiveResume) {
		if (isBlankResume(opts.resume)) opts.resume = effectiveResume;
		if (opts.sessionId !== void 0 && _ClaudeCodeLanguageModel.sessionIdConflictsWithResumeOrContinue({
			resumePresent: opts.resume !== void 0,
			continue: opts.continue === true,
			forkSession: opts.forkSession === true
		})) opts.sessionId = void 0;
	}
	extractToolUses(content) {
		return filterContentBlocks(content, "tool_use").map((block) => {
			const { id, name, input, parent_tool_use_id } = block;
			return {
				id: typeof id === "string" && id.length > 0 ? id : generateId(),
				name: typeof name === "string" && name.length > 0 ? name : _ClaudeCodeLanguageModel.UNKNOWN_TOOL_NAME,
				input,
				parentToolUseId: typeof parent_tool_use_id === "string" ? parent_tool_use_id : null
			};
		});
	}
	extractToolResults(content) {
		return filterContentBlocks(content, "tool_result").map((block) => {
			const { tool_use_id, content: content2, is_error, name } = block;
			return {
				id: typeof tool_use_id === "string" && tool_use_id.length > 0 ? tool_use_id : generateId(),
				name: typeof name === "string" && name.length > 0 ? name : void 0,
				result: content2,
				isError: Boolean(is_error)
			};
		});
	}
	extractToolErrors(content) {
		return filterContentBlocks(content, "tool_error").map((block) => {
			const { tool_use_id, error, name } = block;
			return {
				id: typeof tool_use_id === "string" && tool_use_id.length > 0 ? tool_use_id : generateId(),
				name: typeof name === "string" && name.length > 0 ? name : void 0,
				error
			};
		});
	}
	serializeToolInput(input) {
		if (typeof input === "string") return this.checkInputSize(input);
		if (input === void 0) return "";
		try {
			const serialized = JSON.stringify(input);
			return this.checkInputSize(serialized);
		} catch {
			const fallback = String(input);
			return this.checkInputSize(fallback);
		}
	}
	checkInputSize(str) {
		const length = str.length;
		if (length > _ClaudeCodeLanguageModel.MAX_TOOL_INPUT_SIZE) throw new Error(`Tool input exceeds maximum size of ${_ClaudeCodeLanguageModel.MAX_TOOL_INPUT_SIZE} bytes (got ${length} bytes). This may indicate a malformed request or an attempt to process excessively large data.`);
		if (length > _ClaudeCodeLanguageModel.MAX_TOOL_INPUT_WARN) this.logger.warn(`[claude-code] Large tool input detected: ${length} bytes. Performance may be impacted. Consider chunking or reducing input size.`);
		return str;
	}
	normalizeToolResult(result) {
		if (typeof result === "string") try {
			return JSON.parse(result);
		} catch {
			return result;
		}
		if (Array.isArray(result) && result.length > 0) {
			const textBlocks = result.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text);
			if (textBlocks.length !== result.length) return result;
			if (textBlocks.length === 1) try {
				return JSON.parse(textBlocks[0]);
			} catch {
				return textBlocks[0];
			}
			const combined = textBlocks.join("\n");
			try {
				return JSON.parse(combined);
			} catch {
				return combined;
			}
		}
		return result;
	}
	/**
	* Builds a provider-executed `tool-call` part from an assistant `tool_use`
	* block. Shared by doGenerate (content part) and doStream (stream part) so
	* the two paths cannot drift in field shape.
	*/
	buildToolCallPart(toolCallId, toolName, input, parentToolCallId) {
		return {
			type: "tool-call",
			toolCallId,
			toolName,
			input,
			providerExecuted: true,
			dynamic: true,
			providerMetadata: { "claude-code": {
				rawInput: input,
				parentToolCallId: parentToolCallId ?? null
			} }
		};
	}
	/**
	* Builds a provider-executed `tool-result` part from a user-message
	* `tool_result` block, applying normalization and `maxToolResultSize`
	* truncation. Shared by doGenerate and doStream.
	*/
	buildToolResultPart(toolCallId, toolName, result, isError, parentToolCallId) {
		const normalizedResult = this.normalizeToolResult(result);
		const rawResult = typeof result === "string" ? result : result === void 0 ? "" : (() => {
			try {
				return JSON.stringify(result) ?? String(result);
			} catch {
				return String(result);
			}
		})();
		const maxToolResultSize = this.settings.maxToolResultSize;
		const truncatedResult = truncateToolResultForStream(normalizedResult, maxToolResultSize);
		const truncatedRawResult = truncateToolResultForStream(rawResult, maxToolResultSize);
		return {
			type: "tool-result",
			toolCallId,
			toolName,
			result: truncatedResult ?? "",
			isError,
			dynamic: true,
			providerMetadata: { "claude-code": {
				rawResult: truncatedRawResult,
				rawResultTruncated: truncatedRawResult !== rawResult,
				parentToolCallId: parentToolCallId ?? null
			} }
		};
	}
	serializeToolError(error) {
		return typeof error === "string" ? error : typeof error === "object" && error !== null ? (() => {
			try {
				return JSON.stringify(error) ?? String(error);
			} catch {
				return String(error);
			}
		})() : String(error);
	}
	/**
	* Builds a V4 provider `tool-result` part with `isError: true` from a
	* user-message `tool_error` block. V4 has no provider-level `tool-error`
	* content or stream part; AI SDK core derives user-facing tool-error
	* semantics from this result while preserving providerMetadata.
	*/
	buildErroredToolResultPart(toolCallId, toolName, error, parentToolCallId) {
		const rawError = this.serializeToolError(error);
		return {
			type: "tool-result",
			toolCallId,
			toolName,
			result: rawError,
			isError: true,
			dynamic: true,
			providerMetadata: { "claude-code": {
				rawError,
				parentToolCallId: parentToolCallId ?? null
			} }
		};
	}
	/**
	* Policy (P3): late-frame drop guard, shared by all four tool_result/tool_error
	* sites (doGenerate result+error, doStream result+error). When a frame's tool
	* id is tombstoned (its tool-call was retracted by a supersede/refusal-fallback
	* signal), the frame must be DROPPED rather than re-synthesized into an orphan
	* tool-call. Centralizing the predicate + debug message keeps the four sites in
	* lockstep so a future tombstone change can't be applied to only some of them.
	*/
	isRetractedToolFrame(id, tombstone, frameKind) {
		if (!tombstone.has(id)) return false;
		this.logger.debug(`[claude-code] Dropping tool ${frameKind} for retracted (superseded) tool ID: ${id}`);
		return true;
	}
	resolvePortableReasoningOptions(options, sdkOptions, claudeProviderOptions, warnings) {
		if (this.settings.thinking !== void 0 || this.settings.effort !== void 0 || this.settings.maxThinkingTokens !== void 0 || sdkOptions?.thinking !== void 0 || sdkOptions?.effort !== void 0 || sdkOptions?.maxThinkingTokens !== void 0 || claudeProviderOptions.hasClaudeReasoningSettings || !isCustomReasoning(options.reasoning)) return {};
		if (options.reasoning === "none") return { thinking: { type: "disabled" } };
		const effort = mapReasoningToProviderEffort({
			reasoning: options.reasoning,
			effortMap: CLAUDE_REASONING_EFFORT_MAP,
			warnings: warnings ?? []
		});
		return effort === void 0 ? {} : { effort };
	}
	applyClaudeReasoningProviderOptions(opts, claudeProviderOptions) {
		if (claudeProviderOptions.thinking !== void 0) opts.thinking = claudeProviderOptions.thinking;
		if (claudeProviderOptions.effort !== void 0) opts.effort = claudeProviderOptions.effort;
		if (claudeProviderOptions.maxThinkingTokens !== void 0) opts.maxThinkingTokens = claudeProviderOptions.maxThinkingTokens;
	}
	generateAllWarnings(options, prompt, sdkOptions) {
		const warnings = [];
		const unsupportedParams = [];
		if (options.temperature !== void 0) unsupportedParams.push("temperature");
		if (options.topP !== void 0) unsupportedParams.push("topP");
		if (options.topK !== void 0) unsupportedParams.push("topK");
		if (options.presencePenalty !== void 0) unsupportedParams.push("presencePenalty");
		if (options.frequencyPenalty !== void 0) unsupportedParams.push("frequencyPenalty");
		if (options.stopSequences !== void 0 && options.stopSequences.length > 0) unsupportedParams.push("stopSequences");
		if (options.seed !== void 0) unsupportedParams.push("seed");
		if (unsupportedParams.length > 0) for (const param of unsupportedParams) warnings.push({
			type: "unsupported",
			feature: param,
			details: `Claude Code SDK does not support the ${param} parameter. It will be ignored.`
		});
		if (options.tools !== void 0 && options.tools.length > 0) warnings.push({
			type: "unsupported",
			feature: "tools",
			details: "The Claude Code CLI executes its own tools; AI SDK tools cannot be auto-bridged at the provider layer and will be ignored. To expose custom tools to the CLI, build an in-process MCP server with the createAiSdkMcpServer helper (exported by this package) and pass it via the mcpServers setting (plus allowedTools)."
		});
		if (options.toolChoice !== void 0 && options.toolChoice.type !== "auto") warnings.push({
			type: "unsupported",
			feature: "toolChoice",
			details: `Claude Code CLI does not support toolChoice '${options.toolChoice.type}'. Only automatic tool selection is available; the toolChoice parameter will be ignored.`
		});
		if (options.maxOutputTokens !== void 0) warnings.push({
			type: "unsupported",
			feature: "maxOutputTokens",
			details: "Claude Code CLI does not accept an output token cap. The maxOutputTokens parameter will be ignored."
		});
		if (this.modelValidationWarning) warnings.push({
			type: "other",
			message: this.modelValidationWarning
		});
		this.settingsValidationWarnings.forEach((warning) => {
			warnings.push({
				type: "other",
				message: warning
			});
		});
		if (options.responseFormat?.type === "json" && !options.responseFormat.schema) warnings.push({
			type: "unsupported",
			feature: "responseFormat",
			details: "JSON response format requires a schema for the Claude Code provider. The JSON responseFormat is ignored and the call is treated as plain text."
		});
		const promptWarning = validatePrompt(prompt);
		if (promptWarning) warnings.push({
			type: "other",
			message: promptWarning
		});
		this.resolvePortableReasoningOptions(options, sdkOptions, extractClaudeReasoningProviderOptions(options.providerOptions, warnings), warnings);
		return warnings;
	}
	createQueryOptions(abortController, options, stderrCollector, sdkOptions, effectiveResume) {
		const claudeReasoningProviderOptions = extractClaudeReasoningProviderOptions(options.providerOptions);
		const opts = {
			model: this.getModel(),
			abortController,
			resume: effectiveResume,
			pathToClaudeCodeExecutable: this.settings.pathToClaudeCodeExecutable,
			maxTurns: this.settings.maxTurns,
			maxThinkingTokens: this.settings.maxThinkingTokens,
			thinking: this.settings.thinking,
			effort: this.settings.effort,
			promptSuggestions: this.settings.promptSuggestions,
			cwd: this.settings.cwd,
			executable: this.settings.executable,
			executableArgs: this.settings.executableArgs,
			permissionMode: this.settings.permissionMode,
			permissionPromptToolName: this.settings.permissionPromptToolName,
			continue: this.settings.continue,
			allowedTools: this.settings.allowedTools,
			disallowedTools: this.settings.disallowedTools,
			betas: this.settings.betas,
			allowDangerouslySkipPermissions: this.settings.allowDangerouslySkipPermissions,
			enableFileCheckpointing: this.settings.enableFileCheckpointing,
			maxBudgetUsd: this.settings.maxBudgetUsd,
			plugins: this.settings.plugins,
			resumeSessionAt: this.settings.resumeSessionAt,
			resumeDropsTurn: this.settings.resumeDropsTurn,
			sandbox: this.settings.sandbox,
			tools: this.settings.tools,
			mcpServers: this.settings.mcpServers,
			canUseTool: this.settings.canUseTool,
			onElicitation: this.settings.onElicitation,
			agent: this.settings.agent
		};
		Object.assign(opts, this.resolvePortableReasoningOptions(options, sdkOptions, claudeReasoningProviderOptions));
		if (this.settings.onUserDialog !== void 0) opts.onUserDialog = this.settings.onUserDialog;
		if (this.settings.supportedDialogKinds !== void 0) opts.supportedDialogKinds = this.settings.supportedDialogKinds;
		if (this.settings.systemPrompt !== void 0) opts.systemPrompt = this.settings.systemPrompt;
		else if (this.settings.customSystemPrompt !== void 0) {
			this.logger.warn("[claude-code] 'customSystemPrompt' is deprecated and will be removed in a future major release. Please use 'systemPrompt' instead (string or { type: 'preset', preset: 'claude_code', append? }).");
			opts.systemPrompt = this.settings.customSystemPrompt;
		} else if (this.settings.appendSystemPrompt !== void 0) {
			this.logger.warn("[claude-code] 'appendSystemPrompt' is deprecated and will be removed in a future major release. Please use 'systemPrompt: { type: 'preset', preset: 'claude_code', append: <text> }' instead.");
			opts.systemPrompt = {
				type: "preset",
				preset: "claude_code",
				append: this.settings.appendSystemPrompt
			};
		}
		if (this.settings.settingSources !== void 0) opts.settingSources = this.settings.settingSources;
		else opts.settingSources = [];
		if (this.settings.additionalDirectories !== void 0) opts.additionalDirectories = this.settings.additionalDirectories;
		if (this.settings.agents !== void 0) opts.agents = this.settings.agents;
		if (this.settings.skills !== void 0) opts.skills = this.settings.skills;
		if (this.settings.settings !== void 0) opts.settings = this.settings.settings;
		if (this.settings.managedSettings !== void 0) opts.managedSettings = this.settings.managedSettings;
		if (this.settings.toolAliases !== void 0) opts.toolAliases = this.settings.toolAliases;
		if (this.settings.toolConfig !== void 0) opts.toolConfig = this.settings.toolConfig;
		if (this.settings.planModeInstructions !== void 0) opts.planModeInstructions = this.settings.planModeInstructions;
		if (this.settings.title !== void 0) opts.title = this.settings.title;
		if (this.settings.forwardSubagentText !== void 0) opts.forwardSubagentText = this.settings.forwardSubagentText;
		if (this.settings.agentProgressSummaries !== void 0) opts.agentProgressSummaries = this.settings.agentProgressSummaries;
		if (this.settings.includeHookEvents !== void 0) opts.includeHookEvents = this.settings.includeHookEvents;
		if (this.settings.taskBudget !== void 0) opts.taskBudget = this.settings.taskBudget;
		if (this.settings.sessionStore !== void 0) opts.sessionStore = this.settings.sessionStore;
		if (this.settings.sessionStoreFlush !== void 0) opts.sessionStoreFlush = this.settings.sessionStoreFlush;
		if (this.settings.loadTimeoutMs !== void 0) opts.loadTimeoutMs = this.settings.loadTimeoutMs;
		if (this.settings.includePartialMessages !== void 0) opts.includePartialMessages = this.settings.includePartialMessages;
		if (this.settings.fallbackModel !== void 0) opts.fallbackModel = this.settings.fallbackModel;
		if (this.settings.forkSession !== void 0) opts.forkSession = this.settings.forkSession;
		if (this.settings.strictMcpConfig !== void 0) opts.strictMcpConfig = this.settings.strictMcpConfig;
		if (this.settings.extraArgs !== void 0) opts.extraArgs = this.settings.extraArgs;
		if (this.settings.persistSession !== void 0) opts.persistSession = this.settings.persistSession;
		if (this.settings.spawnClaudeCodeProcess !== void 0) opts.spawnClaudeCodeProcess = this.settings.spawnClaudeCodeProcess;
		if (this.settings.hooks) opts.hooks = this.settings.hooks;
		const effectiveForkSession = sdkOptions?.forkSession ?? this.settings.forkSession;
		const effectiveContinue = sdkOptions?.continue ?? this.settings.continue;
		if (this.settings.sessionId !== void 0 && !_ClaudeCodeLanguageModel.sessionIdConflictsWithResumeOrContinue({
			resumePresent: opts.resume !== void 0,
			continue: effectiveContinue === true,
			forkSession: effectiveForkSession === true
		})) opts.sessionId = this.settings.sessionId;
		if (this.settings.debug !== void 0) opts.debug = this.settings.debug;
		if (this.settings.debugFile !== void 0) opts.debugFile = this.settings.debugFile;
		const sdkOverrides = sdkOptions ? sdkOptions : void 0;
		const sdkEnv = sdkOverrides && typeof sdkOverrides.env === "object" && sdkOverrides.env !== null ? sdkOverrides.env : void 0;
		const sdkStderr = sdkOverrides && typeof sdkOverrides.stderr === "function" ? sdkOverrides.stderr : void 0;
		if (sdkOverrides) {
			const rest = { ...sdkOverrides };
			delete rest.env;
			delete rest.stderr;
			for (const [key, value] of Object.entries(rest)) if (value !== void 0) opts[key] = value;
		}
		this.applyClaudeReasoningProviderOptions(opts, claudeReasoningProviderOptions);
		this.applySessionResolution(opts, effectiveResume);
		if (typeof opts.fallbackModel === "string" && opts.fallbackModel === opts.model) throw new Error(`fallbackModel cannot be the same as the model ('${String(opts.model)}'). Specify a different model for fallbackModel, or remove it.`);
		const userStderrCallback = sdkStderr ?? this.settings.stderr;
		if (stderrCollector || userStderrCallback) opts.stderr = (data) => {
			if (stderrCollector) stderrCollector(data);
			if (userStderrCallback) userStderrCallback(data);
		};
		const mergedEnv = {
			...getBaseProcessEnv(),
			...this.settings.env,
			...sdkEnv
		};
		if (!("CLAUDE_AGENT_SDK_CLIENT_APP" in mergedEnv)) mergedEnv.CLAUDE_AGENT_SDK_CLIENT_APP = DEFAULT_CLIENT_APP;
		opts.env = mergedEnv;
		if (options.responseFormat?.type === "json" && options.responseFormat.schema) {
			const { schema: sanitizedSchema, strippedFormatPaths } = sanitizeJsonSchemaForOutputFormat(options.responseFormat.schema);
			if (strippedFormatPaths.length > 0) this.logger.debug(`[claude-code] Stripped unsupported 'format' keywords from outputFormat schema (hints folded into descriptions; client-side Zod validation still enforces them) at: ${strippedFormatPaths.join(", ")}`);
			opts.outputFormat = {
				type: "json_schema",
				schema: sanitizedSchema
			};
		}
		return opts;
	}
	handleClaudeCodeError(error, messagesPrompt, collectedStderr) {
		if (error instanceof APICallError || error instanceof LoadAPIKeyError) return error;
		const rawSdkStderr = typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string" ? error.stderr : void 0;
		const cappedSdkStderr = rawSdkStderr !== void 0 ? capStderr(rawSdkStderr) : void 0;
		const stderr = (cappedSdkStderr !== void 0 && stderrTail(cappedSdkStderr) ? cappedSdkStderr : collectedStderr ? capStderr(collectedStderr) : void 0) || void 0;
		const tail = stderr ? stderrTail(stderr) : "";
		const appendStderrTail = (message) => tail && !message.includes(STDERR_TAIL_MARKER) ? `${message}${STDERR_TAIL_MARKER} ${tail}` : message;
		if (isAbortError(error)) throw error;
		const isErrorWithMessage = (err) => {
			return typeof err === "object" && err !== null && "message" in err;
		};
		const isErrorWithCode = (err) => {
			return typeof err === "object" && err !== null;
		};
		const authErrorPatterns = [
			"not logged in",
			"authentication",
			"unauthorized",
			"auth failed",
			"please login",
			"claude login",
			"claude auth login",
			"/login",
			"invalid api key",
			"oauth_org_not_allowed"
		];
		const stderrAuthPatterns = [
			"not logged in",
			"not authenticated",
			"auth failed",
			"please login",
			"please run /login",
			"claude login",
			"claude auth login",
			"invalid api key",
			"oauth token revoked",
			"oauth_org_not_allowed"
		];
		const errorMessage = isErrorWithMessage(error) && error.message ? error.message.toLowerCase() : "";
		const stderrMessage = stderr?.toLowerCase() ?? "";
		const errorKind = getStructuredErrorKind(error);
		const exitCode = isErrorWithCode(error) && typeof error.exitCode === "number" ? error.exitCode : void 0;
		if (errorKind === "authentication_failed" || errorKind === "oauth_org_not_allowed" || authErrorPatterns.some((pattern) => errorMessage.includes(pattern)) || stderrAuthPatterns.some((pattern) => stderrMessage.includes(pattern)) || exitCode === 401) return createAuthenticationError({
			message: appendStderrTail(isErrorWithMessage(error) && error.message ? error.message : "Authentication failed. Please ensure Claude Code SDK is properly authenticated."),
			stderr
		});
		const errorCode = isErrorWithCode(error) && typeof error.code === "string" ? error.code : "";
		if (errorCode === "ETIMEDOUT" || errorMessage.includes("timeout") || /request timed out|etimedout/i.test(stderr ?? "")) return createTimeoutError({
			message: appendStderrTail(isErrorWithMessage(error) && error.message ? error.message : "Request timed out"),
			stderr,
			promptExcerpt: messagesPrompt.substring(0, 200)
		});
		if (errorKind === "overloaded" || errorKind === "rate_limit" || errorMessage.includes("overloaded")) return createAPICallError({
			message: isErrorWithMessage(error) && error.message ? error.message : "Anthropic API is overloaded. Please retry.",
			code: errorCode || void 0,
			exitCode,
			stderr,
			promptExcerpt: messagesPrompt.substring(0, 200),
			isRetryable: true
		});
		if (errorKind === "model_not_found" || errorMessage.includes("model_not_found") || errorMessage.includes("no such model")) return createAPICallError({
			message: `${isErrorWithMessage(error) && error.message ? error.message : "Model not found"}. The requested model was not found. Verify the model id passed to the provider (e.g. 'fable', 'opus', 'sonnet', 'haiku', or a full model name) and that your account has access to it.`,
			code: errorCode || void 0,
			exitCode,
			stderr,
			promptExcerpt: messagesPrompt.substring(0, 200),
			isRetryable: false
		});
		const isRetryable = errorCode === "ENOENT" || errorCode === "ECONNREFUSED" || errorCode === "ETIMEDOUT" || errorCode === "ECONNRESET";
		return createAPICallError({
			message: isErrorWithMessage(error) && error.message ? error.message : "Claude Code SDK error",
			code: errorCode || void 0,
			exitCode,
			stderr,
			promptExcerpt: messagesPrompt.substring(0, 200),
			isRetryable
		});
	}
	setSessionId(sessionId) {
		this.sessionId = sessionId;
		const warning = validateSessionId(sessionId);
		if (warning) this.logger.warn(`Claude Code Session: ${warning}`);
	}
	logMcpConnectionIssues(mcpServers) {
		if (!Array.isArray(mcpServers) || mcpServers.length === 0) return;
		const serversNeedingAttention = mcpServers.filter((server) => {
			const status = typeof server.status === "string" ? server.status.toLowerCase() : "";
			return status === "failed" || status === "needs-auth";
		});
		if (serversNeedingAttention.length === 0) return;
		const details = serversNeedingAttention.map((server) => {
			return `${typeof server.name === "string" && server.name.trim().length > 0 ? server.name : "<unknown>"}:${typeof server.status === "string" && server.status.trim().length > 0 ? server.status : "unknown"}${typeof server.error === "string" && server.error.trim().length > 0 ? ` (${server.error})` : ""}`;
		}).join(", ");
		this.logger.warn(`[claude-code] MCP servers not connected: ${details}`);
	}
	/**
	* Handles SDK 0.3.x system messages other than 'init', shared by doGenerate
	* and doStream:
	* - 'api_retry' is counted into providerMetadata (`apiRetries`) and debug-logged.
	* - 'permission_denied' is warn-logged and recorded into providerMetadata
	*   (`permissionDenials`); without this a denial is invisible until the
	*   model talks about it.
	* - 'model_refusal_fallback' is debug-logged (the superseding assistant
	*   message is handled by the text-dedup guard in the message loops).
	* - 'thinking_tokens' deltas are accumulated into providerMetadata
	*   (`estimatedThinkingTokens`); the estimate is explicitly not the
	*   authoritative billed output tokens, so it is surfaced as metadata
	*   instead of feeding `usage.outputTokens.reasoning`.
	* - The subtypes in {@link INFORMATIONAL_SYSTEM_SUBTYPES} are intentionally
	*   informational and only debug-logged.
	*/
	handleSystemMessage(message, tracking, onRetractedUuids) {
		switch (message.subtype) {
			case "api_retry":
				tracking.apiRetries += 1;
				this.logger.debug(`[claude-code] API retry ${message.attempt}/${message.max_retries} in ${message.retry_delay_ms}ms - Status: ${message.error_status ?? "unknown"}, Error: ${message.error}`);
				break;
			case "permission_denied": {
				const reason = message.decision_reason ?? message.message;
				const raw = toJsonSafeValue(message);
				tracking.permissionDenials.push({
					toolName: message.tool_name,
					toolUseId: message.tool_use_id,
					...message.agent_id !== void 0 && { agentId: message.agent_id },
					...message.decision_reason_type !== void 0 && { decisionReasonType: message.decision_reason_type },
					...reason !== void 0 && { reason },
					...raw !== void 0 && { raw }
				});
				this.logger.warn(`[claude-code] Permission denied - Tool: ${message.tool_name}${reason ? `, Reason: ${reason}` : ""}`);
				break;
			}
			case "task_started":
				this.trackTaskEvent({
					subtype: "task_started",
					taskId: message.task_id,
					...message.tool_use_id !== void 0 && { toolUseId: message.tool_use_id },
					description: message.description,
					...message.subagent_type !== void 0 && { subagentType: message.subagent_type },
					...message.task_type !== void 0 && { taskType: message.task_type },
					...message.workflow_name !== void 0 && { workflowName: message.workflow_name },
					...message.prompt !== void 0 && { prompt: message.prompt },
					...message.skip_transcript !== void 0 && { skipTranscript: message.skip_transcript },
					uuid: message.uuid,
					sessionId: message.session_id,
					raw: message
				}, tracking);
				this.logger.debug(`[claude-code] Task started - ID: ${message.task_id}`);
				break;
			case "task_progress":
				this.trackTaskEvent({
					subtype: "task_progress",
					taskId: message.task_id,
					...message.tool_use_id !== void 0 && { toolUseId: message.tool_use_id },
					description: message.description,
					...message.subagent_type !== void 0 && { subagentType: message.subagent_type },
					usage: message.usage,
					...message.last_tool_name !== void 0 && { lastToolName: message.last_tool_name },
					...message.summary !== void 0 && { summary: message.summary },
					uuid: message.uuid,
					sessionId: message.session_id,
					raw: message
				}, tracking);
				this.logger.debug(`[claude-code] Task progress - ID: ${message.task_id}`);
				break;
			case "task_updated":
				this.trackTaskEvent({
					subtype: "task_updated",
					taskId: message.task_id,
					patch: message.patch,
					uuid: message.uuid,
					sessionId: message.session_id,
					raw: message
				}, tracking);
				this.logger.debug(`[claude-code] Task updated - ID: ${message.task_id}`);
				break;
			case "task_notification":
				this.trackTaskEvent({
					subtype: "task_notification",
					taskId: message.task_id,
					...message.tool_use_id !== void 0 && { toolUseId: message.tool_use_id },
					status: message.status,
					outputFile: message.output_file,
					summary: message.summary,
					...message.usage !== void 0 && { usage: message.usage },
					...message.skip_transcript !== void 0 && { skipTranscript: message.skip_transcript },
					uuid: message.uuid,
					sessionId: message.session_id,
					raw: message
				}, tracking);
				this.logger.debug(`[claude-code] Task notification - ID: ${message.task_id}, Status: ${message.status}`);
				break;
			case "hook_started":
				this.trackHookEvent({
					subtype: "hook_started",
					hookId: message.hook_id,
					hookName: message.hook_name,
					hookEvent: message.hook_event,
					uuid: message.uuid,
					sessionId: message.session_id,
					raw: message
				}, tracking);
				this.logger.debug(`[claude-code] Hook started - ID: ${message.hook_id}, Event: ${message.hook_event}`);
				break;
			case "hook_progress":
				this.trackHookEvent({
					subtype: "hook_progress",
					hookId: message.hook_id,
					hookName: message.hook_name,
					hookEvent: message.hook_event,
					stdout: message.stdout,
					stderr: message.stderr,
					output: message.output,
					uuid: message.uuid,
					sessionId: message.session_id,
					raw: message
				}, tracking);
				this.logger.debug(`[claude-code] Hook progress - ID: ${message.hook_id}, Event: ${message.hook_event}`);
				break;
			case "hook_response":
				this.trackHookEvent({
					subtype: "hook_response",
					hookId: message.hook_id,
					hookName: message.hook_name,
					hookEvent: message.hook_event,
					output: message.output,
					stdout: message.stdout,
					stderr: message.stderr,
					...message.exit_code !== void 0 && { exitCode: message.exit_code },
					outcome: message.outcome,
					uuid: message.uuid,
					sessionId: message.session_id,
					raw: message
				}, tracking);
				this.logger.debug(`[claude-code] Hook response - ID: ${message.hook_id}, Outcome: ${message.outcome}`);
				break;
			case "mirror_error": {
				const mirrorError = message.error ?? "unknown error";
				const mirrorSessionId = message.key?.sessionId ?? message.session_id ?? "unknown";
				tracking.mirrorErrors.push({
					error: mirrorError,
					sessionId: mirrorSessionId
				});
				this.logger.warn(`[claude-code] SessionStore mirror error (transcript batch dropped) - Session: ${mirrorSessionId}, Error: ${mirrorError}`);
				break;
			}
			case "model_refusal_fallback": {
				this.logger.debug(`[claude-code] Model refusal fallback - ${message.original_model} -> ${message.fallback_model} (direction: ${message.direction})`);
				const retractedUuids = message.retracted_message_uuids;
				if (onRetractedUuids && retractedUuids && retractedUuids.length > 0) {
					this.logger.debug(`[claude-code] Refusal fallback retracts ${retractedUuids.length} message uuid(s)`);
					onRetractedUuids(retractedUuids);
				}
				break;
			}
			case "thinking_tokens":
				tracking.estimatedThinkingTokens += message.estimated_tokens_delta;
				this.logger.debug(`[claude-code] Thinking tokens estimate - block total: ${message.estimated_tokens}, delta: ${message.estimated_tokens_delta}, accumulated: ${tracking.estimatedThinkingTokens}`);
				break;
			default: if (INFORMATIONAL_SYSTEM_SUBTYPES.has(message.subtype)) this.logger.debug(`[claude-code] Ignoring informational system message: ${message.subtype}`);
			else this.logger.debug(`[claude-code] Unhandled system message subtype: ${message.subtype}`);
		}
	}
	/**
	* Merges the result message's `permission_denials` list into the tracked
	* denials. PreToolUse-hook denies bypass canUseTool and emit no
	* `permission_denied` system event (per the SDK docs on
	* SDKPermissionDeniedMessage), so the result list is the only place they
	* surface. Entries already recorded from stream-time events are deduped by
	* `tool_use_id`.
	*/
	mergeResultPermissionDenials(message, tracking) {
		for (const denial of message.permission_denials ?? []) {
			if (tracking.permissionDenials.some((d) => d.toolUseId !== void 0 && d.toolUseId === denial.tool_use_id)) continue;
			const agentId = typeof denial.agent_id === "string" ? denial.agent_id : typeof denial.agentId === "string" ? denial.agentId : void 0;
			const decisionReasonType = typeof denial.decision_reason_type === "string" ? denial.decision_reason_type : typeof denial.decisionReasonType === "string" ? denial.decisionReasonType : void 0;
			const reason = typeof denial.decision_reason === "string" ? denial.decision_reason : typeof denial.reason === "string" ? denial.reason : typeof denial.message === "string" ? denial.message : void 0;
			const raw = toJsonSafeValue(denial);
			tracking.permissionDenials.push({
				toolName: denial.tool_name,
				toolUseId: denial.tool_use_id,
				...agentId !== void 0 && { agentId },
				...decisionReasonType !== void 0 && { decisionReasonType },
				...reason !== void 0 && { reason },
				...raw !== void 0 && { raw }
			});
		}
	}
	/**
	* Bounded post-result drain for the `prompt_suggestion` message
	* (promptSuggestions: true), shared by doGenerate and doStream. The
	* suggestion arrives AFTER the result message; the SDK emits at most one
	* per turn, so stop once it is delivered, and a timeout closes the
	* iterator (tearing down the subprocess) if the CLI lingers after the
	* result without emitting one. Drained messages still pass through the
	* generic raw SDK callback before prompt-specific handling.
	*/
	async drainPromptSuggestion(iterator, onPromptSuggestion) {
		let drainTimer;
		const drainTimeout = new Promise((resolve) => {
			drainTimer = setTimeout(() => resolve("timeout"), _ClaudeCodeLanguageModel.PROMPT_SUGGESTION_DRAIN_TIMEOUT_MS);
			drainTimer.unref?.();
		});
		try {
			while (true) {
				const winner = await Promise.race([iterator.next(), drainTimeout]);
				if (winner === "timeout") {
					this.logger.debug("[claude-code] Post-result drain timed out; closing SDK iterator");
					iterator.return?.().catch(() => {});
					break;
				}
				if (winner.done) break;
				const trailingMessage = winner.value;
				this.logger.debug(`[claude-code] Post-result message type: ${trailingMessage.type}`);
				this.invokeSdkMessageCallback(trailingMessage);
				if (trailingMessage.type === "prompt_suggestion") {
					onPromptSuggestion?.(trailingMessage.suggestion);
					iterator.return?.().catch(() => {});
					break;
				}
			}
		} catch (drainError) {
			this.logger.debug(`[claude-code] Error draining post-result messages: ${drainError instanceof Error ? drainError.message : String(drainError)}`);
		} finally {
			if (drainTimer !== void 0) clearTimeout(drainTimer);
		}
	}
	async doGenerate(options) {
		this.logger.debug(`[claude-code] Starting doGenerate request with model: ${this.modelId}`);
		this.logger.debug(`[claude-code] Response format: ${options.responseFormat?.type ?? "none"}`);
		const { messagesPrompt, warnings: messageWarnings, streamingContentParts, hasImageParts } = convertToClaudeCodeMessages(options.prompt);
		this.logger.debug(`[claude-code] Converted ${options.prompt.length} messages, hasImageParts: ${hasImageParts}`);
		const abortController = new AbortController();
		let abortListener;
		if (options.abortSignal?.aborted) abortController.abort(options.abortSignal.reason);
		let collectedStderr = "";
		const stderrCollector = (data) => {
			collectedStderr += data;
			collectedStderr = capStderr(collectedStderr);
		};
		const sdkOptions = this.getSanitizedSdkOptions();
		const effectiveResume = this.getEffectiveResume(sdkOptions);
		const queryOptions = this.createQueryOptions(abortController, options, stderrCollector, sdkOptions, effectiveResume);
		if (options.abortSignal && !options.abortSignal.aborted) {
			abortListener = () => abortController.abort(options.abortSignal?.reason);
			options.abortSignal.addEventListener("abort", abortListener, { once: true });
		}
		let text = "";
		const contentSegments = [];
		const joinTextSegments = () => contentSegments.filter((segment) => segment.kind === "text").map((segment) => segment.text).join("");
		const joinFinalTurnTextSegments = () => {
			let start = 0;
			for (let i = 0; i < contentSegments.length; i++) {
				const kind = contentSegments[i]?.kind;
				if (kind === "tool-result" || kind === "tool-error") start = i + 1;
			}
			return contentSegments.slice(start).filter((segment) => segment.kind === "text").map((segment) => segment.text).join("");
		};
		const knownTools = /* @__PURE__ */ new Map();
		const retractedToolIds = /* @__PURE__ */ new Set();
		const evictBuffered = (retracted) => {
			if (retracted.size === 0) return;
			const retractedToolCallIds = computeRetractedToolCallIds(retracted, contentSegments.filter((segment) => segment.kind === "tool-call" || segment.kind === "tool-result" || segment.kind === "tool-error").map((segment) => ({
				toolCallId: segment.toolCallId,
				uuid: segment.uuid
			})));
			for (const toolCallId of retractedToolCallIds) {
				retractedToolIds.add(toolCallId);
				knownTools.delete(toolCallId);
				activeTaskTools.delete(toolCallId);
			}
			for (let i = contentSegments.length - 1; i >= 0; i--) {
				const segment = contentSegments[i];
				if (segment === void 0) continue;
				const segmentUuid = "uuid" in segment ? segment.uuid : void 0;
				if (segmentUuid !== void 0 && retracted.has(segmentUuid) || (segment.kind === "tool-result" || segment.kind === "tool-error") && retractedToolCallIds.has(segment.toolCallId)) contentSegments.splice(i, 1);
			}
		};
		const activeTaskTools = /* @__PURE__ */ new Map();
		const getFallbackParentId = () => {
			if (activeTaskTools.size === 1) return activeTaskTools.keys().next().value ?? null;
			return null;
		};
		let structuredOutput;
		let receivedResultMessage = false;
		let usage = createEmptyUsage();
		let finishReason = {
			unified: "stop",
			raw: void 0
		};
		let wasTruncated = false;
		let costUsd;
		let durationMs;
		let modelUsage;
		let ttftMs;
		let ttftStreamMs;
		let timeToRequestMs;
		let warmSpareClaimed;
		let terminalReason;
		const metadataTracking = {
			apiRetries: 0,
			permissionDenials: [],
			mirrorErrors: [],
			estimatedThinkingTokens: 0,
			taskEvents: [],
			hookEvents: []
		};
		const warnings = this.generateAllWarnings(options, messagesPrompt, sdkOptions);
		if (messageWarnings) messageWarnings.forEach((warning) => {
			warnings.push({
				type: "other",
				message: warning
			});
		});
		const modeSetting = this.settings.streamingInput ?? "auto";
		const effectiveCanUseTool = sdkOptions?.canUseTool ?? this.settings.canUseTool;
		const effectivePermissionPromptToolName = sdkOptions?.permissionPromptToolName ?? this.settings.permissionPromptToolName;
		const wantsStreamInput = modeSetting === "always" || modeSetting === "auto" && (!!effectiveCanUseTool || hasImageParts);
		if (!wantsStreamInput && hasImageParts) warnings.push({
			type: "other",
			message: STREAMING_FEATURE_WARNING
		});
		let done = () => {};
		const outputStreamEnded = new Promise((resolve) => {
			done = () => resolve(void 0);
		});
		try {
			if (effectiveCanUseTool && effectivePermissionPromptToolName) throw new Error("canUseTool requires streamingInput mode ('auto' or 'always') and cannot be used with permissionPromptToolName (SDK constraint). Set streamingInput: 'auto' (or 'always') and remove permissionPromptToolName, or remove canUseTool.");
			const sdkPrompt = wantsStreamInput ? toAsyncIterablePrompt(messagesPrompt, outputStreamEnded, effectiveResume, streamingContentParts, this.settings.onStreamStart) : messagesPrompt;
			this.logger.debug(`[claude-code] Executing query with streamingInput: ${wantsStreamInput}, session: ${effectiveResume ?? "new"}`);
			const response = COt({
				prompt: sdkPrompt,
				options: queryOptions
			});
			this.notifyQueryCreated(response);
			let lastAssistantErrorKind;
			const sdkIterator = response[Symbol.asyncIterator]();
			const detachableResponse = { [Symbol.asyncIterator]: () => ({
				next: () => sdkIterator.next(),
				return: () => {
					sdkIterator.return?.().catch(() => {});
					return Promise.resolve({
						done: true,
						value: void 0
					});
				}
			}) };
			for await (const message of detachableResponse) {
				this.logger.debug(`[claude-code] Received message type: ${message.type}`);
				this.invokeSdkMessageCallback(message);
				if (message.type === "assistant") {
					if (typeof message.error === "string") lastAssistantErrorKind = message.error;
					applySupersede(message, evictBuffered, this.logger, "truthy");
					const messageUuid = typeof message.uuid === "string" ? message.uuid : void 0;
					const sdkParentToolUseId = message.parent_tool_use_id;
					const content = message.message.content;
					if (Array.isArray(content)) for (const block of content) {
						if (!isContentBlock(block)) continue;
						if (block.type === "text" && typeof block.text === "string") {
							if (block.text.length > 0) contentSegments.push({
								kind: "text",
								...messageUuid !== void 0 && { uuid: messageUuid },
								text: block.text
							});
						} else if (block.type === "thinking" && typeof block.thinking === "string") contentSegments.push({
							kind: "reasoning",
							...messageUuid !== void 0 && { uuid: messageUuid },
							text: block.thinking
						});
						else if (block.type === "tool_use") {
							const [tool3] = this.extractToolUses([block]);
							if (!tool3) continue;
							if (isInternalStructuredOutputTool(tool3.name, options)) continue;
							const parentToolCallId = isSubagentToolName(tool3.name) ? null : resolveToolParentId(sdkParentToolUseId, tool3.parentToolUseId, getFallbackParentId);
							this.logger.debug(`[claude-code] Tool use detected - Tool: ${tool3.name}, ID: ${tool3.id}, SDK parent: ${sdkParentToolUseId}, resolved parent: ${parentToolCallId}`);
							knownTools.set(tool3.id, {
								name: tool3.name,
								parentToolCallId
							});
							if (isSubagentToolName(tool3.name)) activeTaskTools.set(tool3.id, { startTime: Date.now() });
							contentSegments.push({
								kind: "tool-call",
								...messageUuid !== void 0 && { uuid: messageUuid },
								toolCallId: tool3.id,
								part: this.buildToolCallPart(tool3.id, tool3.name, this.serializeToolInput(tool3.input), parentToolCallId)
							});
						}
					}
					text = joinTextSegments();
				} else if (message.type === "user") {
					if (!message.message?.content) {
						this.logger.warn(`[claude-code] Unexpected user message structure: missing content field. Message type: ${message.type}. This may indicate an SDK protocol violation.`);
						continue;
					}
					const sdkParentToolUseIdForResults = message.parent_tool_use_id;
					const resultMessageUuid = typeof message.uuid === "string" ? message.uuid : void 0;
					const content = message.message.content;
					for (const result of this.extractToolResults(content)) {
						if (this.isRetractedToolFrame(result.id, retractedToolIds, "result")) continue;
						const known = knownTools.get(result.id);
						const toolName = result.name ?? known?.name ?? _ClaudeCodeLanguageModel.UNKNOWN_TOOL_NAME;
						this.logger.debug(`[claude-code] Tool result received - Tool: ${toolName}, ID: ${result.id}`);
						let parentToolCallId;
						if (known) {
							known.name = toolName;
							parentToolCallId = known.parentToolCallId;
						} else {
							this.logger.warn(`[claude-code] Received tool result for unknown tool ID: ${result.id}`);
							parentToolCallId = isSubagentToolName(toolName) ? null : resolveToolParentId(sdkParentToolUseIdForResults, void 0, getFallbackParentId);
							knownTools.set(result.id, {
								name: toolName,
								parentToolCallId
							});
							contentSegments.push({
								kind: "tool-call",
								toolCallId: result.id,
								part: this.buildToolCallPart(result.id, toolName, "", parentToolCallId)
							});
						}
						if (isSubagentToolName(toolName)) activeTaskTools.delete(result.id);
						contentSegments.push({
							kind: "tool-result",
							...resultMessageUuid !== void 0 && { uuid: resultMessageUuid },
							toolCallId: result.id,
							part: this.buildToolResultPart(result.id, toolName, result.result, result.isError, parentToolCallId)
						});
					}
					for (const error of this.extractToolErrors(content)) {
						if (this.isRetractedToolFrame(error.id, retractedToolIds, "error")) continue;
						const known = knownTools.get(error.id);
						const toolName = error.name ?? known?.name ?? _ClaudeCodeLanguageModel.UNKNOWN_TOOL_NAME;
						this.logger.debug(`[claude-code] Tool error received - Tool: ${toolName}, ID: ${error.id}`);
						let parentToolCallId;
						if (known) {
							known.name = toolName;
							parentToolCallId = known.parentToolCallId;
						} else {
							this.logger.warn(`[claude-code] Received tool error for unknown tool ID: ${error.id}`);
							parentToolCallId = isSubagentToolName(toolName) ? null : resolveToolParentId(sdkParentToolUseIdForResults, void 0, getFallbackParentId);
							knownTools.set(error.id, {
								name: toolName,
								parentToolCallId
							});
							contentSegments.push({
								kind: "tool-call",
								toolCallId: error.id,
								part: this.buildToolCallPart(error.id, toolName, "", parentToolCallId)
							});
						}
						if (isSubagentToolName(toolName)) activeTaskTools.delete(error.id);
						contentSegments.push({
							kind: "tool-error",
							...resultMessageUuid !== void 0 && { uuid: resultMessageUuid },
							toolCallId: error.id,
							part: this.buildErroredToolResultPart(error.id, toolName, error.error, parentToolCallId)
						});
					}
				} else if (message.type === "result") {
					done();
					receivedResultMessage = true;
					this.setSessionId(message.session_id);
					costUsd = message.total_cost_usd;
					durationMs = message.duration_ms;
					modelUsage = message.modelUsage;
					if ("ttft_ms" in message) ttftMs = message.ttft_ms;
					if ("ttft_stream_ms" in message) ttftStreamMs = message.ttft_stream_ms;
					if ("time_to_request_ms" in message) timeToRequestMs = message.time_to_request_ms;
					if ("warm_spare_claimed" in message) warmSpareClaimed = message.warm_spare_claimed;
					terminalReason = message.terminal_reason;
					this.mergeResultPermissionDenials(message, metadataTracking);
					if ("is_error" in message && message.is_error === true) {
						const resultText = "result" in message && typeof message.result === "string" ? message.result : void 0;
						const errorsText = "errors" in message && Array.isArray(message.errors) ? message.errors.filter((e) => typeof e === "string").join("; ") : "";
						throw Object.assign(new Error(resultText ?? (errorsText || "Claude Code CLI returned an error")), {
							exitCode: 1,
							errorKind: lastAssistantErrorKind
						});
					}
					if (message.subtype === "error_max_structured_output_retries") throw new Error("Failed to generate valid structured output after maximum retries. The model could not produce a response matching the required schema.");
					if ("structured_output" in message && message.structured_output !== void 0) {
						structuredOutput = message.structured_output;
						this.logger.debug("[claude-code] Received structured output from SDK");
					}
					this.logger.info(`[claude-code] Request completed - Session: ${message.session_id}, Cost: $${costUsd?.toFixed(4) ?? "N/A"}, Duration: ${durationMs ?? "N/A"}ms`);
					if ("usage" in message) {
						usage = convertClaudeCodeUsage(message.usage);
						this.logger.debug(`[claude-code] Token usage - Input: ${usage.inputTokens.total}, Output: ${usage.outputTokens.total}`);
					}
					const stopReason = "stop_reason" in message ? message.stop_reason : void 0;
					finishReason = mapClaudeCodeFinishReason(message.subtype, stopReason);
					if (structuredOutput !== void 0 && finishReason.unified === "tool-calls") finishReason = {
						unified: "stop",
						raw: finishReason.raw
					};
					this.logger.debug(`[claude-code] Finish reason: ${finishReason.unified}`);
					if ((sdkOptions?.promptSuggestions ?? this.settings.promptSuggestions) !== false && (this.settings.onPromptSuggestion !== void 0 || this.settings.onSdkMessage !== void 0)) await this.drainPromptSuggestion(sdkIterator, this.settings.onPromptSuggestion);
					break;
				} else if (message.type === "system" && message.subtype === "init") {
					this.logMcpConnectionIssues(message.mcp_servers);
					this.trackMcpStatusFromInit(message, metadataTracking);
					this.setSessionId(message.session_id);
					this.logger.info(`[claude-code] Session initialized: ${message.session_id}`);
				} else if (message.type === "system") this.handleSystemMessage(message, metadataTracking, buildRetractionEvictor(evictBuffered));
			}
		} catch (error) {
			done();
			this.logger.debug(`[claude-code] Error during doGenerate: ${error instanceof Error ? error.message : String(error)}`);
			if (isAbortError(error)) {
				this.logger.debug("[claude-code] Request aborted by user");
				throw options.abortSignal?.aborted ? options.abortSignal.reason : error;
			}
			if (isClaudeCodeTruncationError(error, text)) {
				this.logger.warn(`[claude-code] Detected truncated response, returning ${text.length} characters of buffered text`);
				wasTruncated = true;
				finishReason = {
					unified: "length",
					raw: "truncation"
				};
				warnings.push({
					type: "other",
					message: CLAUDE_CODE_TRUNCATION_WARNING
				});
			} else throw this.handleClaudeCodeError(error, messagesPrompt, collectedStderr);
		} finally {
			if (options.abortSignal && abortListener) options.abortSignal.removeEventListener("abort", abortListener);
		}
		if (options.responseFormat?.type === "json" && options.responseFormat.schema !== void 0 && receivedResultMessage && structuredOutput === void 0 && !wasTruncated && finishReason.unified === "stop") {
			const recoveredJsonText = extractJsonObjectText(joinFinalTurnTextSegments()) ?? extractJsonObjectText(joinTextSegments());
			if (recoveredJsonText !== void 0) {
				this.logger.warn("[claude-code] outputFormat was requested but the CLI returned no structured_output; recovered JSON by parsing the prose response. The schema likely contains constructs the CLI cannot enforce - see the README structured-output limitations.");
				structuredOutput = JSON.parse(recoveredJsonText);
			} else throw createAPICallError({
				message: MISSING_STRUCTURED_OUTPUT_ERROR_MESSAGE,
				promptExcerpt: messagesPrompt.substring(0, 200),
				isRetryable: false
			});
		}
		const thinkingTraces = contentSegments.filter((segment) => segment.kind === "reasoning").map((segment) => segment.text);
		const contentParts = [];
		for (const segment of contentSegments) if (segment.kind === "reasoning") contentParts.push({
			type: "reasoning",
			text: segment.text
		});
		else if (segment.kind === "text") {
			if (structuredOutput !== void 0) continue;
			const last = contentParts[contentParts.length - 1];
			if (last !== void 0 && last.type === "text") last.text += segment.text;
			else contentParts.push({
				type: "text",
				text: segment.text
			});
		} else contentParts.push(segment.part);
		if (structuredOutput !== void 0) contentParts.push({
			type: "text",
			text: JSON.stringify(structuredOutput)
		});
		else if (!contentParts.some((part) => part.type === "text")) contentParts.push({
			type: "text",
			text: ""
		});
		return {
			content: contentParts,
			usage,
			finishReason,
			warnings,
			response: {
				id: generateId(),
				timestamp: /* @__PURE__ */ new Date(),
				modelId: this.modelId
			},
			request: { body: messagesPrompt },
			providerMetadata: { "claude-code": {
				...this.sessionId !== void 0 && { sessionId: this.sessionId },
				...costUsd !== void 0 && { costUsd },
				...durationMs !== void 0 && { durationMs },
				...modelUsage !== void 0 && { modelUsage },
				...ttftMs !== void 0 && { ttftMs },
				...ttftStreamMs !== void 0 && { ttftStreamMs },
				...timeToRequestMs !== void 0 && { timeToRequestMs },
				...warmSpareClaimed !== void 0 && { warmSpareClaimed },
				...terminalReason !== void 0 && { terminalReason },
				...metadataTracking.apiRetries > 0 && { apiRetries: metadataTracking.apiRetries },
				...metadataTracking.permissionDenials.length > 0 && { permissionDenials: metadataTracking.permissionDenials },
				...metadataTracking.taskEvents.length > 0 && { taskEvents: metadataTracking.taskEvents },
				...metadataTracking.hookEvents.length > 0 && { hookEvents: metadataTracking.hookEvents },
				...metadataTracking.mcpServers !== void 0 && { mcpServers: metadataTracking.mcpServers },
				...metadataTracking.mirrorErrors.length > 0 && { mirrorErrors: metadataTracking.mirrorErrors },
				...metadataTracking.estimatedThinkingTokens > 0 && { estimatedThinkingTokens: metadataTracking.estimatedThinkingTokens },
				...wasTruncated && { truncated: true },
				...thinkingTraces.length > 0 && { thinkingTraces }
			} }
		};
	}
	async doStream(options) {
		this.logger.debug(`[claude-code] Starting doStream request with model: ${this.modelId}`);
		this.logger.debug(`[claude-code] Response format: ${options.responseFormat?.type ?? "none"}`);
		const { messagesPrompt, warnings: messageWarnings, streamingContentParts, hasImageParts } = convertToClaudeCodeMessages(options.prompt);
		this.logger.debug(`[claude-code] Converted ${options.prompt.length} messages for streaming, hasImageParts: ${hasImageParts}`);
		const abortController = new AbortController();
		let abortListener;
		if (options.abortSignal?.aborted) abortController.abort(options.abortSignal.reason);
		let collectedStderr = "";
		const stderrCollector = (data) => {
			collectedStderr += data;
			collectedStderr = capStderr(collectedStderr);
		};
		const sdkOptions = this.getSanitizedSdkOptions();
		const effectiveResume = this.getEffectiveResume(sdkOptions);
		const queryOptions = this.createQueryOptions(abortController, options, stderrCollector, sdkOptions, effectiveResume);
		if (options.abortSignal && !options.abortSignal.aborted) {
			abortListener = () => abortController.abort(options.abortSignal?.reason);
			options.abortSignal.addEventListener("abort", abortListener, { once: true });
		}
		if (queryOptions.includePartialMessages === void 0) queryOptions.includePartialMessages = true;
		const warnings = this.generateAllWarnings(options, messagesPrompt, sdkOptions);
		if (messageWarnings) messageWarnings.forEach((warning) => {
			warnings.push({
				type: "other",
				message: warning
			});
		});
		const modeSetting = this.settings.streamingInput ?? "auto";
		const effectiveCanUseTool = sdkOptions?.canUseTool ?? this.settings.canUseTool;
		const effectivePermissionPromptToolName = sdkOptions?.permissionPromptToolName ?? this.settings.permissionPromptToolName;
		const wantsStreamInput = modeSetting === "always" || modeSetting === "auto" && (!!effectiveCanUseTool || hasImageParts);
		if (!wantsStreamInput && hasImageParts) warnings.push({
			type: "other",
			message: STREAMING_FEATURE_WARNING
		});
		return {
			stream: new ReadableStream({
				start: async (controller) => {
					let done = () => {};
					const outputStreamEnded = new Promise((resolve) => {
						done = () => resolve(void 0);
					});
					const toolStates = /* @__PURE__ */ new Map();
					const retractedStreamToolIds = /* @__PURE__ */ new Set();
					const activeTaskTools = /* @__PURE__ */ new Map();
					const getFallbackParentId = () => {
						if (activeTaskTools.size === 1) return activeTaskTools.keys().next().value ?? null;
						return null;
					};
					const streamWarnings = [];
					const closeToolInput = (toolId, state) => {
						if (!state.inputClosed && state.inputStarted) {
							controller.enqueue({
								type: "tool-input-end",
								id: toolId
							});
							state.inputClosed = true;
						}
					};
					const emitToolCall = (toolId, state) => {
						if (state.callEmitted) return;
						closeToolInput(toolId, state);
						controller.enqueue(this.buildToolCallPart(toolId, state.name, state.lastSerializedInput ?? "", state.parentToolCallId));
						state.callEmitted = true;
					};
					const finalizeToolCalls = () => {
						for (const [toolId, state] of toolStates) emitToolCall(toolId, state);
						toolStates.clear();
					};
					let usage = createEmptyUsage();
					let accumulatedText = "";
					const textSegments = [];
					let textPartId;
					let streamedTextLength = 0;
					let emittedTextSinceLastAssistant = "";
					let hasReceivedStreamEvents = false;
					let hasStreamedJson = false;
					let lastAssistantErrorKind;
					const metadataTracking = {
						apiRetries: 0,
						permissionDenials: [],
						mirrorErrors: [],
						estimatedThinkingTokens: 0,
						taskEvents: [],
						hookEvents: []
					};
					const toolBlocksByIndex = /* @__PURE__ */ new Map();
					const structuredOutputBlockIndexes = /* @__PURE__ */ new Set();
					const nonTextToolBlockIndexes = /* @__PURE__ */ new Set();
					const toolInputAccumulators = /* @__PURE__ */ new Map();
					const textBlocksByIndex = /* @__PURE__ */ new Map();
					let textStreamedViaContentBlock = false;
					const reasoningBlocksByIndex = /* @__PURE__ */ new Map();
					let currentReasoningPartId;
					const evictLive = (retracted) => {
						if (retracted.size === 0) return;
						for (let i = textSegments.length - 1; i >= 0; i--) {
							const segmentUuid = textSegments[i]?.uuid;
							if (segmentUuid !== void 0 && retracted.has(segmentUuid)) textSegments.splice(i, 1);
						}
						accumulatedText = textSegments.map((segment) => segment.text).join("");
						const retractedToolCallIds = computeRetractedToolCallIds(retracted, [...toolStates].map(([toolId, state]) => ({
							toolCallId: toolId,
							uuid: state.messageUuid
						})));
						for (const toolId of retractedToolCallIds) {
							const state = toolStates.get(toolId);
							if (!state) continue;
							activeTaskTools.delete(toolId);
							if (!state.callEmitted) {
								closeToolInput(toolId, state);
								toolStates.delete(toolId);
								retractedStreamToolIds.add(toolId);
								toolInputAccumulators.delete(toolId);
								for (const [blockIndex, mappedId] of toolBlocksByIndex) if (mappedId === toolId) toolBlocksByIndex.delete(blockIndex);
								this.logger.debug(`[claude-code] Retracted pending tool call from superseded message - ID: ${toolId}`);
							}
						}
					};
					try {
						controller.enqueue({
							type: "stream-start",
							warnings
						});
						if (effectiveCanUseTool && effectivePermissionPromptToolName) throw new Error("canUseTool requires streamingInput mode ('auto' or 'always') and cannot be used with permissionPromptToolName (SDK constraint). Set streamingInput: 'auto' (or 'always') and remove permissionPromptToolName, or remove canUseTool.");
						const sdkPrompt = wantsStreamInput ? toAsyncIterablePrompt(messagesPrompt, outputStreamEnded, effectiveResume, streamingContentParts, this.settings.onStreamStart) : messagesPrompt;
						this.logger.debug(`[claude-code] Starting stream query with streamingInput: ${wantsStreamInput}, session: ${effectiveResume ?? "new"}`);
						const response = COt({
							prompt: sdkPrompt,
							options: queryOptions
						});
						this.notifyQueryCreated(response);
						const sdkIterator = response[Symbol.asyncIterator]();
						const detachableResponse = { [Symbol.asyncIterator]: () => ({
							next: () => sdkIterator.next(),
							return: () => {
								sdkIterator.return?.().catch(() => {});
								return Promise.resolve({
									done: true,
									value: void 0
								});
							}
						}) };
						for await (const message of detachableResponse) {
							this.logger.debug(`[claude-code] Stream received message type: ${message.type}`);
							this.invokeSdkMessageCallback(message);
							if (options.includeRawChunks) controller.enqueue({
								type: "raw",
								rawValue: message
							});
							if (message.type === "stream_event") {
								const event = message.event;
								if (event.type === "content_block_delta" && event.delta.type === "text_delta" && "text" in event.delta && event.delta.text) {
									const deltaText = event.delta.text;
									hasReceivedStreamEvents = true;
									if (options.responseFormat?.type === "json") {
										accumulatedText += deltaText;
										streamedTextLength += deltaText.length;
										continue;
									}
									if (!textPartId) {
										textPartId = generateId();
										controller.enqueue({
											type: "text-start",
											id: textPartId
										});
									}
									controller.enqueue({
										type: "text-delta",
										id: textPartId,
										delta: deltaText
									});
									accumulatedText += deltaText;
									streamedTextLength += deltaText.length;
									emittedTextSinceLastAssistant += deltaText;
								}
								if (event.type === "content_block_delta" && event.delta.type === "input_json_delta" && "partial_json" in event.delta && event.delta.partial_json) {
									const jsonDelta = event.delta.partial_json;
									hasReceivedStreamEvents = true;
									const blockIndex = "index" in event ? event.index : -1;
									const isStructuredOutputDelta = structuredOutputBlockIndexes.has(blockIndex) || !toolBlocksByIndex.has(blockIndex) && !nonTextToolBlockIndexes.has(blockIndex);
									if (options.responseFormat?.type === "json" && isStructuredOutputDelta) {
										if (!textPartId) {
											textPartId = generateId();
											controller.enqueue({
												type: "text-start",
												id: textPartId
											});
										}
										controller.enqueue({
											type: "text-delta",
											id: textPartId,
											delta: jsonDelta
										});
										accumulatedText += jsonDelta;
										streamedTextLength += jsonDelta.length;
										hasStreamedJson = true;
										continue;
									}
									const toolId = toolBlocksByIndex.get(blockIndex);
									if (toolId) {
										const accumulated = (toolInputAccumulators.get(toolId) ?? "") + jsonDelta;
										toolInputAccumulators.set(toolId, accumulated);
										controller.enqueue({
											type: "tool-input-delta",
											id: toolId,
											delta: jsonDelta
										});
										continue;
									}
								}
								if (event.type === "content_block_start" && "content_block" in event && isNonTextToolUseContentBlockType(event.content_block?.type)) {
									const blockIndex = "index" in event ? event.index : -1;
									hasReceivedStreamEvents = true;
									nonTextToolBlockIndexes.add(blockIndex);
									structuredOutputBlockIndexes.delete(blockIndex);
									continue;
								}
								if (event.type === "content_block_start" && "content_block" in event && event.content_block?.type === "tool_use") {
									const blockIndex = "index" in event ? event.index : -1;
									const toolBlock = event.content_block;
									const toolId = typeof toolBlock.id === "string" && toolBlock.id.length > 0 ? toolBlock.id : generateId();
									const toolName = typeof toolBlock.name === "string" && toolBlock.name.length > 0 ? toolBlock.name : _ClaudeCodeLanguageModel.UNKNOWN_TOOL_NAME;
									hasReceivedStreamEvents = true;
									nonTextToolBlockIndexes.delete(blockIndex);
									if (isInternalStructuredOutputTool(toolName, options)) {
										structuredOutputBlockIndexes.add(blockIndex);
										continue;
									}
									structuredOutputBlockIndexes.delete(blockIndex);
									if (textPartId) {
										const closedTextId = textPartId;
										controller.enqueue({
											type: "text-end",
											id: closedTextId
										});
										textPartId = void 0;
										for (const [idx, blockTextId] of textBlocksByIndex) if (blockTextId === closedTextId) {
											textBlocksByIndex.delete(idx);
											break;
										}
									}
									toolBlocksByIndex.set(blockIndex, toolId);
									toolInputAccumulators.set(toolId, "");
									let state = toolStates.get(toolId);
									if (!state) {
										const partialParentId = message.parent_tool_use_id;
										const currentParentId = isSubagentToolName(toolName) ? null : resolveToolParentId(partialParentId, void 0, getFallbackParentId);
										const envelopeUuid = message.uuid;
										state = {
											name: toolName,
											inputStarted: false,
											inputClosed: false,
											callEmitted: false,
											parentToolCallId: currentParentId,
											...typeof envelopeUuid === "string" && { messageUuid: envelopeUuid }
										};
										toolStates.set(toolId, state);
									}
									if (!state.inputStarted) {
										this.logger.debug(`[claude-code] Tool input started (content_block) - Tool: ${toolName}, ID: ${toolId}, parent: ${state.parentToolCallId}`);
										controller.enqueue({
											type: "tool-input-start",
											id: toolId,
											toolName,
											providerExecuted: true,
											dynamic: true,
											providerMetadata: { "claude-code": { parentToolCallId: state.parentToolCallId ?? null } }
										});
										if (isSubagentToolName(toolName)) activeTaskTools.set(toolId, { startTime: Date.now() });
										state.inputStarted = true;
									}
									continue;
								}
								if (event.type === "content_block_start" && "content_block" in event && event.content_block?.type === "text") {
									const blockIndex = "index" in event ? event.index : -1;
									hasReceivedStreamEvents = true;
									const partId = generateId();
									textBlocksByIndex.set(blockIndex, partId);
									textPartId = partId;
									this.logger.debug(`[claude-code] Text content block started - Index: ${blockIndex}, ID: ${partId}`);
									controller.enqueue({
										type: "text-start",
										id: partId
									});
									textStreamedViaContentBlock = true;
									continue;
								}
								if (event.type === "content_block_start" && "content_block" in event && event.content_block?.type === "thinking") {
									const blockIndex = "index" in event ? event.index : -1;
									hasReceivedStreamEvents = true;
									if (textPartId) {
										const closedTextId = textPartId;
										controller.enqueue({
											type: "text-end",
											id: closedTextId
										});
										textPartId = void 0;
										for (const [idx, blockTextId] of textBlocksByIndex) if (blockTextId === closedTextId) {
											textBlocksByIndex.delete(idx);
											break;
										}
									}
									const reasoningPartId = generateId();
									reasoningBlocksByIndex.set(blockIndex, reasoningPartId);
									currentReasoningPartId = reasoningPartId;
									this.logger.debug(`[claude-code] Reasoning started (content_block) - ID: ${reasoningPartId}`);
									controller.enqueue({
										type: "reasoning-start",
										id: reasoningPartId
									});
									continue;
								}
								if (event.type === "content_block_delta" && event.delta.type === "thinking_delta" && "thinking" in event.delta && event.delta.thinking) {
									const blockIndex = "index" in event ? event.index : -1;
									const reasoningPartId = reasoningBlocksByIndex.get(blockIndex) ?? currentReasoningPartId;
									hasReceivedStreamEvents = true;
									if (reasoningPartId) controller.enqueue({
										type: "reasoning-delta",
										id: reasoningPartId,
										delta: event.delta.thinking
									});
									continue;
								}
								if (event.type === "content_block_stop") {
									const blockIndex = "index" in event ? event.index : -1;
									hasReceivedStreamEvents = true;
									const toolId = toolBlocksByIndex.get(blockIndex);
									if (toolId) {
										const state = toolStates.get(toolId);
										if (state && !state.inputClosed) {
											const accumulatedInput = toolInputAccumulators.get(toolId) ?? "";
											this.logger.debug(`[claude-code] Tool content block stopped - Index: ${blockIndex}, Tool: ${state.name}, ID: ${toolId}`);
											controller.enqueue({
												type: "tool-input-end",
												id: toolId
											});
											state.inputClosed = true;
											const effectiveInput = accumulatedInput || state.lastSerializedInput || "";
											state.lastSerializedInput = effectiveInput;
											if (!state.callEmitted) {
												controller.enqueue(this.buildToolCallPart(toolId, state.name, effectiveInput, state.parentToolCallId));
												state.callEmitted = true;
											}
										}
										toolBlocksByIndex.delete(blockIndex);
										toolInputAccumulators.delete(toolId);
										continue;
									}
									if (structuredOutputBlockIndexes.delete(blockIndex)) continue;
									if (nonTextToolBlockIndexes.delete(blockIndex)) continue;
									const textId = textBlocksByIndex.get(blockIndex);
									if (textId) {
										this.logger.debug(`[claude-code] Text content block stopped - Index: ${blockIndex}, ID: ${textId}`);
										controller.enqueue({
											type: "text-end",
											id: textId
										});
										textBlocksByIndex.delete(blockIndex);
										if (textPartId === textId) textPartId = void 0;
										continue;
									}
									const reasoningPartId = reasoningBlocksByIndex.get(blockIndex);
									if (reasoningPartId) {
										this.logger.debug(`[claude-code] Reasoning ended (content_block) - ID: ${reasoningPartId}`);
										controller.enqueue({
											type: "reasoning-end",
											id: reasoningPartId
										});
										reasoningBlocksByIndex.delete(blockIndex);
										if (currentReasoningPartId === reasoningPartId) currentReasoningPartId = void 0;
										continue;
									}
								}
								continue;
							}
							if (message.type === "assistant") {
								if (typeof message.error === "string") lastAssistantErrorKind = message.error;
								const supersedesPriorMessages = applySupersede(message, evictLive, this.logger);
								if (!message.message?.content) {
									this.logger.warn(`[claude-code] Unexpected assistant message structure: missing content field. Message type: ${message.type}. This may indicate an SDK protocol violation.`);
									continue;
								}
								const sdkParentToolUseId = message.parent_tool_use_id;
								const content = message.message.content;
								const tools = this.extractToolUses(content).filter((tool3) => !isInternalStructuredOutputTool(tool3.name, options));
								if (textPartId && tools.length > 0) {
									const closedTextId = textPartId;
									controller.enqueue({
										type: "text-end",
										id: closedTextId
									});
									textPartId = void 0;
									for (const [idx, blockTextId] of textBlocksByIndex) if (blockTextId === closedTextId) {
										textBlocksByIndex.delete(idx);
										break;
									}
								}
								for (const tool3 of tools) {
									const toolId = tool3.id;
									let state = toolStates.get(toolId);
									if (!state) {
										const currentParentId = isSubagentToolName(tool3.name) ? null : resolveToolParentId(sdkParentToolUseId, tool3.parentToolUseId, getFallbackParentId);
										state = {
											name: tool3.name,
											inputStarted: false,
											inputClosed: false,
											callEmitted: false,
											parentToolCallId: currentParentId,
											...typeof message.uuid === "string" && { messageUuid: message.uuid }
										};
										toolStates.set(toolId, state);
										this.logger.debug(`[claude-code] New tool use detected - Tool: ${tool3.name}, ID: ${toolId}, SDK parent: ${sdkParentToolUseId}, resolved parent: ${currentParentId}`);
									} else if (!state.parentToolCallId && sdkParentToolUseId && !isSubagentToolName(tool3.name)) {
										state.parentToolCallId = sdkParentToolUseId;
										this.logger.debug(`[claude-code] Retroactive parent context - Tool: ${tool3.name}, ID: ${toolId}, parent: ${sdkParentToolUseId}`);
									}
									state.name = tool3.name;
									if (!state.inputStarted) {
										this.logger.debug(`[claude-code] Tool input started - Tool: ${tool3.name}, ID: ${toolId}`);
										controller.enqueue({
											type: "tool-input-start",
											id: toolId,
											toolName: tool3.name,
											providerExecuted: true,
											dynamic: true,
											providerMetadata: { "claude-code": { parentToolCallId: state.parentToolCallId ?? null } }
										});
										if (isSubagentToolName(tool3.name)) activeTaskTools.set(toolId, { startTime: Date.now() });
										state.inputStarted = true;
									}
									const serializedInput = this.serializeToolInput(tool3.input);
									if (serializedInput) {
										let deltaPayload = "";
										if (state.lastSerializedInput === void 0) {
											if (serializedInput.length <= _ClaudeCodeLanguageModel.MAX_DELTA_CALC_SIZE) deltaPayload = serializedInput;
										} else if (serializedInput.length <= _ClaudeCodeLanguageModel.MAX_DELTA_CALC_SIZE && state.lastSerializedInput.length <= _ClaudeCodeLanguageModel.MAX_DELTA_CALC_SIZE && serializedInput.startsWith(state.lastSerializedInput)) deltaPayload = serializedInput.slice(state.lastSerializedInput.length);
										else if (serializedInput !== state.lastSerializedInput) deltaPayload = "";
										if (deltaPayload) controller.enqueue({
											type: "tool-input-delta",
											id: toolId,
											delta: deltaPayload
										});
										state.lastSerializedInput = serializedInput;
									}
								}
								const text = content.map((c) => c.type === "text" ? c.text : "").join("");
								if (text) {
									if (supersedesPriorMessages) {
										textSegments.push({
											...typeof message.uuid === "string" && { uuid: message.uuid },
											text
										});
										accumulatedText = textSegments.map((segment) => segment.text).join("");
										if (emittedTextSinceLastAssistant === text) {
											streamedTextLength = Math.max(streamedTextLength, text.length);
											this.logger.debug("[claude-code] Skipping text emission for superseding assistant message (replacement already streamed)");
										} else if (emittedTextSinceLastAssistant.length > 0 && text.startsWith(emittedTextSinceLastAssistant)) {
											if (options.responseFormat?.type !== "json") {
												const suffix = text.slice(emittedTextSinceLastAssistant.length);
												if (suffix) {
													if (!textPartId) {
														textPartId = generateId();
														controller.enqueue({
															type: "text-start",
															id: textPartId
														});
													}
													controller.enqueue({
														type: "text-delta",
														id: textPartId,
														delta: suffix
													});
													emittedTextSinceLastAssistant = text;
												}
											}
											streamedTextLength = Math.max(streamedTextLength, text.length);
											this.logger.debug("[claude-code] Emitted unstreamed suffix of superseding assistant message");
										} else if (options.responseFormat?.type !== "json") {
											if (textPartId) {
												const closedTextId = textPartId;
												controller.enqueue({
													type: "text-end",
													id: closedTextId
												});
												textPartId = void 0;
												for (const [idx, blockTextId] of textBlocksByIndex) if (blockTextId === closedTextId) {
													textBlocksByIndex.delete(idx);
													break;
												}
											}
											textPartId = generateId();
											controller.enqueue({
												type: "text-start",
												id: textPartId
											});
											controller.enqueue({
												type: "text-delta",
												id: textPartId,
												delta: text
											});
											streamedTextLength = Math.max(streamedTextLength, text.length);
											this.logger.debug("[claude-code] Emitted superseding assistant message as a new text part (canonical replacement)");
										}
									} else if (hasReceivedStreamEvents) {
										const newTextStart = streamedTextLength;
										const deltaText = text.length > newTextStart ? text.slice(newTextStart) : "";
										accumulatedText = text;
										textSegments.length = 0;
										textSegments.push({
											...typeof message.uuid === "string" && { uuid: message.uuid },
											text
										});
										if (options.responseFormat?.type !== "json" && deltaText) {
											if (!textPartId) {
												textPartId = generateId();
												controller.enqueue({
													type: "text-start",
													id: textPartId
												});
											}
											controller.enqueue({
												type: "text-delta",
												id: textPartId,
												delta: deltaText
											});
										}
										streamedTextLength = text.length;
									} else {
										accumulatedText += text;
										textSegments.push({
											...typeof message.uuid === "string" && { uuid: message.uuid },
											text
										});
										if (options.responseFormat?.type !== "json") {
											if (!textPartId) {
												textPartId = generateId();
												controller.enqueue({
													type: "text-start",
													id: textPartId
												});
											}
											controller.enqueue({
												type: "text-delta",
												id: textPartId,
												delta: text
											});
										}
									}
								}
								emittedTextSinceLastAssistant = "";
							} else if (message.type === "user") {
								if (!message.message?.content) {
									this.logger.warn(`[claude-code] Unexpected user message structure: missing content field. Message type: ${message.type}. This may indicate an SDK protocol violation.`);
									continue;
								}
								if (textPartId) {
									const closedTextId = textPartId;
									controller.enqueue({
										type: "text-end",
										id: closedTextId
									});
									textPartId = void 0;
									for (const [blockIndex, blockTextId] of textBlocksByIndex) if (blockTextId === closedTextId) {
										textBlocksByIndex.delete(blockIndex);
										break;
									}
									this.logger.debug("[claude-code] Closed text part due to user message");
								}
								accumulatedText = "";
								textSegments.length = 0;
								streamedTextLength = 0;
								emittedTextSinceLastAssistant = "";
								const sdkParentToolUseIdForResults = message.parent_tool_use_id;
								const content = message.message.content;
								for (const result of this.extractToolResults(content)) {
									if (this.isRetractedToolFrame(result.id, retractedStreamToolIds, "result")) continue;
									let state = toolStates.get(result.id);
									const toolName = result.name ?? state?.name ?? _ClaudeCodeLanguageModel.UNKNOWN_TOOL_NAME;
									this.logger.debug(`[claude-code] Tool result received - Tool: ${toolName}, ID: ${result.id}`);
									if (!state) {
										this.logger.warn(`[claude-code] Received tool result for unknown tool ID: ${result.id}`);
										state = {
											name: toolName,
											inputStarted: false,
											inputClosed: false,
											callEmitted: false,
											parentToolCallId: isSubagentToolName(toolName) ? null : resolveToolParentId(sdkParentToolUseIdForResults, void 0, getFallbackParentId)
										};
										toolStates.set(result.id, state);
										if (!state.inputStarted) {
											controller.enqueue({
												type: "tool-input-start",
												id: result.id,
												toolName,
												providerExecuted: true,
												dynamic: true,
												providerMetadata: { "claude-code": { parentToolCallId: state.parentToolCallId ?? null } }
											});
											state.inputStarted = true;
										}
										if (!state.inputClosed) {
											controller.enqueue({
												type: "tool-input-end",
												id: result.id
											});
											state.inputClosed = true;
										}
									}
									state.name = toolName;
									emitToolCall(result.id, state);
									if (isSubagentToolName(toolName)) activeTaskTools.delete(result.id);
									controller.enqueue(this.buildToolResultPart(result.id, toolName, result.result, result.isError, state.parentToolCallId));
								}
								for (const error of this.extractToolErrors(content)) {
									if (this.isRetractedToolFrame(error.id, retractedStreamToolIds, "error")) continue;
									let state = toolStates.get(error.id);
									const toolName = error.name ?? state?.name ?? _ClaudeCodeLanguageModel.UNKNOWN_TOOL_NAME;
									this.logger.debug(`[claude-code] Tool error received - Tool: ${toolName}, ID: ${error.id}`);
									if (!state) {
										this.logger.warn(`[claude-code] Received tool error for unknown tool ID: ${error.id}`);
										state = {
											name: toolName,
											inputStarted: false,
											inputClosed: false,
											callEmitted: false,
											parentToolCallId: isSubagentToolName(toolName) ? null : resolveToolParentId(sdkParentToolUseIdForResults, void 0, getFallbackParentId)
										};
										toolStates.set(error.id, state);
										if (!state.inputStarted) {
											controller.enqueue({
												type: "tool-input-start",
												id: error.id,
												toolName,
												providerExecuted: true,
												dynamic: true,
												providerMetadata: { "claude-code": { parentToolCallId: state.parentToolCallId ?? null } }
											});
											state.inputStarted = true;
										}
										if (!state.inputClosed) {
											controller.enqueue({
												type: "tool-input-end",
												id: error.id
											});
											state.inputClosed = true;
										}
									}
									emitToolCall(error.id, state);
									if (isSubagentToolName(toolName)) activeTaskTools.delete(error.id);
									controller.enqueue(this.buildErroredToolResultPart(error.id, toolName, error.error, state.parentToolCallId));
								}
							} else if (message.type === "result") {
								done();
								this.mergeResultPermissionDenials(message, metadataTracking);
								if ("is_error" in message && message.is_error === true) {
									const resultText = "result" in message && typeof message.result === "string" ? message.result : void 0;
									const errorsText = "errors" in message && Array.isArray(message.errors) ? message.errors.filter((e) => typeof e === "string").join("; ") : "";
									throw Object.assign(new Error(resultText ?? (errorsText || "Claude Code CLI returned an error")), {
										exitCode: 1,
										errorKind: lastAssistantErrorKind
									});
								}
								if (message.subtype === "error_max_structured_output_retries") throw new Error("Failed to generate valid structured output after maximum retries. The model could not produce a response matching the required schema.");
								this.logger.info(`[claude-code] Stream completed - Session: ${message.session_id}, Cost: $${message.total_cost_usd?.toFixed(4) ?? "N/A"}, Duration: ${message.duration_ms ?? "N/A"}ms`);
								if ("usage" in message) {
									usage = convertClaudeCodeUsage(message.usage);
									this.logger.debug(`[claude-code] Stream token usage - Input: ${usage.inputTokens.total}, Output: ${usage.outputTokens.total}`);
								}
								const stopReason = "stop_reason" in message ? message.stop_reason : void 0;
								let finishReason = mapClaudeCodeFinishReason(message.subtype, stopReason);
								this.setSessionId(message.session_id);
								const structuredOutput = "structured_output" in message ? message.structured_output : void 0;
								if (structuredOutput !== void 0 && finishReason.unified === "tool-calls") finishReason = {
									unified: "stop",
									raw: finishReason.raw
								};
								this.logger.debug(`[claude-code] Stream finish reason: ${finishReason.unified}`);
								if (hasStreamedJson && options.responseFormat?.type === "json" && hasReceivedStreamEvents) {
									if (textPartId) controller.enqueue({
										type: "text-end",
										id: textPartId
									});
								} else if (structuredOutput !== void 0) {
									const jsonTextId = generateId();
									const jsonText = JSON.stringify(structuredOutput);
									controller.enqueue({
										type: "text-start",
										id: jsonTextId
									});
									controller.enqueue({
										type: "text-delta",
										id: jsonTextId,
										delta: jsonText
									});
									controller.enqueue({
										type: "text-end",
										id: jsonTextId
									});
								} else if (options.responseFormat?.type === "json" && options.responseFormat.schema !== void 0 && finishReason.unified === "stop") {
									const recoveredJsonText = extractJsonObjectText(accumulatedText);
									if (recoveredJsonText === void 0) throw createAPICallError({
										message: MISSING_STRUCTURED_OUTPUT_ERROR_MESSAGE,
										promptExcerpt: messagesPrompt.substring(0, 200),
										isRetryable: false
									});
									this.logger.warn("[claude-code] outputFormat was requested but the CLI returned no structured_output; recovered JSON by parsing the prose response. The schema likely contains constructs the CLI cannot enforce - see the README structured-output limitations.");
									if (textPartId) controller.enqueue({
										type: "text-end",
										id: textPartId
									});
									const recoveredTextId = generateId();
									controller.enqueue({
										type: "text-start",
										id: recoveredTextId
									});
									controller.enqueue({
										type: "text-delta",
										id: recoveredTextId,
										delta: recoveredJsonText
									});
									controller.enqueue({
										type: "text-end",
										id: recoveredTextId
									});
								} else if (textPartId) controller.enqueue({
									type: "text-end",
									id: textPartId
								});
								else if (accumulatedText && !textStreamedViaContentBlock) {
									const fallbackTextId = generateId();
									controller.enqueue({
										type: "text-start",
										id: fallbackTextId
									});
									controller.enqueue({
										type: "text-delta",
										id: fallbackTextId,
										delta: accumulatedText
									});
									controller.enqueue({
										type: "text-end",
										id: fallbackTextId
									});
								}
								finalizeToolCalls();
								const warningsJson = this.serializeWarningsForMetadata(streamWarnings);
								controller.enqueue({
									type: "finish",
									finishReason,
									usage,
									providerMetadata: { "claude-code": {
										sessionId: message.session_id,
										...message.total_cost_usd !== void 0 && { costUsd: message.total_cost_usd },
										...message.duration_ms !== void 0 && { durationMs: message.duration_ms },
										...message.modelUsage !== void 0 && { modelUsage: message.modelUsage },
										..."ttft_ms" in message && message.ttft_ms !== void 0 && { ttftMs: message.ttft_ms },
										..."ttft_stream_ms" in message && message.ttft_stream_ms !== void 0 && { ttftStreamMs: message.ttft_stream_ms },
										..."time_to_request_ms" in message && message.time_to_request_ms !== void 0 && { timeToRequestMs: message.time_to_request_ms },
										..."warm_spare_claimed" in message && message.warm_spare_claimed !== void 0 && { warmSpareClaimed: message.warm_spare_claimed },
										...message.terminal_reason !== void 0 && { terminalReason: message.terminal_reason },
										...metadataTracking.apiRetries > 0 && { apiRetries: metadataTracking.apiRetries },
										...metadataTracking.permissionDenials.length > 0 && { permissionDenials: metadataTracking.permissionDenials },
										...metadataTracking.taskEvents.length > 0 && { taskEvents: metadataTracking.taskEvents },
										...metadataTracking.hookEvents.length > 0 && { hookEvents: metadataTracking.hookEvents },
										...metadataTracking.mcpServers !== void 0 && { mcpServers: metadataTracking.mcpServers },
										...metadataTracking.mirrorErrors.length > 0 && { mirrorErrors: metadataTracking.mirrorErrors },
										...metadataTracking.estimatedThinkingTokens > 0 && { estimatedThinkingTokens: metadataTracking.estimatedThinkingTokens },
										...streamWarnings.length > 0 && { warnings: warningsJson }
									} }
								});
								controller.close();
								if ((sdkOptions?.promptSuggestions ?? this.settings.promptSuggestions) !== false && (this.settings.onPromptSuggestion !== void 0 || this.settings.onSdkMessage !== void 0)) await this.drainPromptSuggestion(sdkIterator, this.settings.onPromptSuggestion);
								return;
							} else if (message.type === "system" && message.subtype === "init") {
								this.logMcpConnectionIssues(message.mcp_servers);
								this.trackMcpStatusFromInit(message, metadataTracking);
								this.setSessionId(message.session_id);
								this.logger.info(`[claude-code] Stream session initialized: ${message.session_id}`);
								controller.enqueue({
									type: "response-metadata",
									id: message.session_id,
									timestamp: /* @__PURE__ */ new Date(),
									modelId: this.modelId
								});
							} else if (message.type === "system") this.handleSystemMessage(message, metadataTracking, buildRetractionEvictor(evictLive));
							else if (message.type === "prompt_suggestion") {
								this.logger.debug("[claude-code] Received prompt suggestion");
								this.settings.onPromptSuggestion?.(message.suggestion);
							}
						}
						finalizeToolCalls();
						this.logger.debug("[claude-code] Stream finalized, closing stream");
						controller.close();
					} catch (error) {
						done();
						this.logger.debug(`[claude-code] Error during doStream: ${error instanceof Error ? error.message : String(error)}`);
						if (isClaudeCodeTruncationError(error, accumulatedText)) {
							this.logger.warn(`[claude-code] Detected truncated stream response, returning ${accumulatedText.length} characters of buffered text`);
							const truncationWarning = {
								type: "other",
								message: CLAUDE_CODE_TRUNCATION_WARNING
							};
							streamWarnings.push(truncationWarning);
							if (textPartId) controller.enqueue({
								type: "text-end",
								id: textPartId
							});
							else if (accumulatedText && !textStreamedViaContentBlock) {
								const fallbackTextId = generateId();
								controller.enqueue({
									type: "text-start",
									id: fallbackTextId
								});
								controller.enqueue({
									type: "text-delta",
									id: fallbackTextId,
									delta: accumulatedText
								});
								controller.enqueue({
									type: "text-end",
									id: fallbackTextId
								});
							}
							finalizeToolCalls();
							const warningsJson = this.serializeWarningsForMetadata(streamWarnings);
							controller.enqueue({
								type: "finish",
								finishReason: {
									unified: "length",
									raw: "truncation"
								},
								usage,
								providerMetadata: { "claude-code": {
									...this.sessionId !== void 0 && { sessionId: this.sessionId },
									truncated: true,
									...metadataTracking.apiRetries > 0 && { apiRetries: metadataTracking.apiRetries },
									...metadataTracking.permissionDenials.length > 0 && { permissionDenials: metadataTracking.permissionDenials },
									...metadataTracking.taskEvents.length > 0 && { taskEvents: metadataTracking.taskEvents },
									...metadataTracking.hookEvents.length > 0 && { hookEvents: metadataTracking.hookEvents },
									...metadataTracking.mcpServers !== void 0 && { mcpServers: metadataTracking.mcpServers },
									...metadataTracking.mirrorErrors.length > 0 && { mirrorErrors: metadataTracking.mirrorErrors },
									...metadataTracking.estimatedThinkingTokens > 0 && { estimatedThinkingTokens: metadataTracking.estimatedThinkingTokens },
									...streamWarnings.length > 0 && { warnings: warningsJson }
								} }
							});
							controller.close();
							return;
						}
						finalizeToolCalls();
						let errorToEmit;
						if (isAbortError(error)) errorToEmit = options.abortSignal?.aborted ? options.abortSignal.reason : error;
						else errorToEmit = this.handleClaudeCodeError(error, messagesPrompt, collectedStderr);
						controller.enqueue({
							type: "error",
							error: errorToEmit
						});
						controller.close();
					} finally {
						if (options.abortSignal && abortListener) options.abortSignal.removeEventListener("abort", abortListener);
					}
				},
				cancel: () => {
					if (options.abortSignal && abortListener) options.abortSignal.removeEventListener("abort", abortListener);
				}
			}),
			request: { body: messagesPrompt }
		};
	}
	serializeWarningsForMetadata(warnings) {
		return warnings.map((warning) => {
			const base = { type: warning.type };
			switch (warning.type) {
				case "unsupported":
				case "compatibility":
					base.feature = warning.feature;
					if (warning.details !== void 0) base.details = warning.details;
					break;
				case "deprecated":
					base.setting = warning.setting;
					base.message = warning.message;
					break;
				case "other": base.message = warning.message;
			}
			return base;
		});
	}
};
function createClaudeCode(options = {}) {
	const logger = getLogger(options.defaultSettings?.logger);
	if (options.defaultSettings) {
		const validation = validateSettings(options.defaultSettings);
		if (!validation.valid) throw new Error(`Invalid default settings: ${validation.errors.join(", ")}`);
		if (validation.warnings.length > 0) validation.warnings.forEach((warning) => logger.warn(`Claude Code Provider: ${warning}`));
	}
	const createModel = (modelId, settings = {}) => {
		const mergedSettings = {
			...options.defaultSettings,
			...settings
		};
		const validation = validateSettings(mergedSettings);
		if (!validation.valid) throw new Error(`Invalid settings: ${validation.errors.join(", ")}`);
		return new ClaudeCodeLanguageModel({
			id: modelId,
			settings: mergedSettings,
			settingsValidationWarnings: validation.warnings
		});
	};
	const provider = function(modelId, settings) {
		if (new.target) throw new Error("The Claude Code model function cannot be called with the new keyword.");
		return createModel(modelId, settings);
	};
	provider.languageModel = createModel;
	provider.chat = createModel;
	provider.specificationVersion = "v4";
	provider.embeddingModel = (modelId) => {
		throw new NoSuchModelError({
			modelId,
			modelType: "embeddingModel"
		});
	};
	provider.imageModel = (modelId) => {
		throw new NoSuchModelError({
			modelId,
			modelType: "imageModel"
		});
	};
	return provider;
}
var claudeCode = createClaudeCode();
//#endregion
export { claudeCode as t };
