# OpenRouter + AI SDK 7 research (for AGE-386 PR 2)

Verified 2026-09-06 against the published tarballs of
`@openrouter/ai-sdk-provider@3.0.0`, `ai@7.0.79` and `@ai-sdk/provider@4.0.8`
(the version `ai@7.0.79` resolves), plus the OpenRouter API reference.

## `@openrouter/ai-sdk-provider` 3.0.0

- Latest stable on npm; peer deps `ai: ^7.0.0` and `zod: ^3.25.76 || ^4.1.8`,
  so it drops straight onto the `ai@7.0.79` this repo already pins for the
  harness steps. (There is a `6.0.0-alpha.*` line; it is a prerelease.)
- `createOpenRouter(options?: OpenRouterProviderSettings): OpenRouterProvider`.
  The provider is callable: `createOpenRouter({ apiKey })("anthropic/claude-sonnet-4.5")`
  returns an `OpenRouterChatLanguageModel`, which declares
  `specificationVersion: "v4"` and `provider: "openrouter"` — assignable to the
  AI SDK's `LanguageModel` union without a wrapper.
- `OpenRouterProviderSettings` that matter here: `apiKey`, `baseURL`,
  `headers`, `fetch`, `extraBody`, `appName` (sets `X-OpenRouter-Title`) and
  `appUrl` (sets `HTTP-Referer`). `compatibility` is `'strict' | 'compatible'`,
  defaulting to `'compatible'`; the exported default `openrouter` instance uses
  `'strict'`.
- With no `apiKey`, the provider falls back to `loadApiKey` on the
  `OPENROUTER_API_KEY` environment variable. jigs passes the key explicitly so
  the env the service was started with is the one that pays.
- Constructing a model performs no network call and does not validate the key,
  so a missing key surfaces at the first generation, not at service start.
  That is why the startup gate checks the variable itself.
- Model ids are OpenRouter's `<vendor>/<model>` slugs; the provider does not
  enumerate or validate them.

## Model catalogue — `GET /api/v1/models`

Probed live 2026-09-06 (`curl https://openrouter.ai/api/v1/models`):

- `GET https://openrouter.ai/api/v1/models` → **200 with or without an
  `Authorization` header**. jigs sends the key anyway, so a doctor run on a
  future auth-gated build keeps working.
- Response: `{ "data": [ { "id": "openai/gpt-6-astra", "canonical_slug": …,
  "name": …, … } ], "total_count": 431, "links": { "next": null } }`. One
  page at 431 models; `links.next` was null, so jigs reads `data` and does
  not follow pagination.
- The `data` ids include the 88 suffixed variants (`…:free`, `…:batch`), which
  is why membership is tested against the id verbatim rather than a
  vendor/slug split.
- A per-model endpoint also exists — `GET /api/v1/models/{author}/{slug}/endpoints`,
  200 for a real id (variants included), 404 for a bogus one. The list is used
  instead because doctor can name the vendor's other models in its repair text
  from it; a 404 can only say "no".

## `ai` 7.0.79 — the tool loop

- `generateText({ model, system, messages, tools, stopWhen })`. `stepCountIs(n)`
  is exported from `ai` (an alias of `isStepCount`) and stops the loop when
  `steps.length === n`.
- `tool({ description, inputSchema, execute })` takes a zod schema as
  `inputSchema` (not `parameters`, which was the v4 name).
- `result.text` is the **final** step's text. A run that ends on a tool call
  has `text === ""`, so a caller that posts `result.text` verbatim posts
  nothing.
- `timeout` takes `number | { totalMs, stepMs, firstChunkMs, chunkMs, toolMs,
  tools }` (`TimeoutConfiguration`). It is enforced by aborting the
  `abortSignal` handed to the provider's `doGenerate`, so a provider (or a
  mock) that ignores that signal is not bounded by it.
- `ai/test` exports `MockLanguageModelV3` and `MockLanguageModelV4`, both
  accepting `doGenerate` as a function, one result, or an **array of results
  consumed one per call** — which is what makes a multi-step tool loop testable
  with no network. `doGenerateCalls` records the options each call received.

### The finish-reason shape (the trap)

`LanguageModelV3FinishReason` / `V4FinishReason` are **objects**, not strings:

```ts
finishReason: { unified: "tool-calls", raw: undefined }
```

`unified` is one of `stop | length | content-filter | tool-calls | error |
other`. Tool execution is gated on
`isToolExecutionAllowedFinishReason(finishReason.unified)` — anything else and
the SDK returns the tool call unexecuted, the loop ends after one step, and
`result.text` is empty. A mock that returns the old plain string
`finishReason: "tool-calls"` reproduces exactly that, silently.

## AI SDK version alignment

`ai@7.0.79` resolves `@ai-sdk/provider@4.0.8` and `@ai-sdk/provider-utils@5.0.30`.
`generateText`'s `LanguageModel` union accepts V2, V3 and V4 models, so the
provider's V4 model and the V3 mock both work against the same call.

Sources: the three npm tarballs' `dist/index.d.ts` and `dist/index.js`,
openrouter.ai/docs (provider settings, model slugs, API keys), and the AI SDK
v7 `generate-text` sources in the published bundle.
