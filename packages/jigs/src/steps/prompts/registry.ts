// Prompts are markdown files rendered here, on the step side, because a block
// runs in the workflow sandbox where no file can be read. A registry maps a
// short name to a source — a file, an inline string, or a plain function — and
// `render` turns a name plus its data into the text an agent is handed. The
// direction of trust is one-way and load-bearing: a template comes only from
// jigs or from the factory, and the data a block passes is only ever
// interpolated into it. Nothing renders data as a template, so a ticket body
// carrying `<%` is text like any other. Missing data is an error rather than a
// blank: `it` is a proxy that throws when a template reads a variable its
// caller never passed, naming both the prompt and the variable.

import { readFileSync } from "node:fs";
import path from "node:path";
import { Eta } from "eta/core";
import type { JsonValue } from "../../blocks/ticket/halt-for-human.ts";
import { factoryRoot } from "../../config/factory-root.ts";

/** What a block passes with a prompt name — the values its template reads. */
export type PromptData = Record<string, JsonValue>;

/**
 * Where a registered prompt's text comes from: a markdown file (absolute, or
 * relative to the registry's root), an inline template string, or a function
 * that skips Eta altogether.
 */
export type PromptSource =
  | { file: string }
  | { template: string }
  | ((data: PromptData) => string);

/** One prompt that could not be loaded or rendered, as `check()` reports it. */
export type PromptCheckFailure = { name: string; error: string };

export interface PromptRegistry {
  render(name: string, data: PromptData): string;
  names(): string[];
  /**
   * Renders every registered template with every variable resolved to
   * `«NAME»`, so a syntax error is a finding here rather than a dead run.
   */
  check(): PromptCheckFailure[];
}

export interface PromptRegistryOptions {
  /**
   * What a source's relative `file` resolves against. Defaults to the factory
   * root, read on first use so importing a registry touches no filesystem.
   */
  root?: string | (() => string);
  /** Seam for tests, so a registry can be exercised without files on disk. */
  readFile?: (file: string) => string;
}

// `it` is reassigned by the compiled template's first line, so every read —
// in the prompt and in any fragment it includes — goes through the proxy.
const FUNCTION_HEADER = "it = this.wrapPromptData(it);";

class PromptEta extends Eta {
  /** The prompt being rendered, so an error inside a fragment still names it. */
  rendering = "";
  /** Off for `check()`, where every variable resolves to a placeholder. */
  strict = true;

  wrapPromptData(data: object): object {
    const { rendering, strict } = this;
    return new Proxy(data, {
      get(target, key) {
        if (typeof key === "symbol" || Object.hasOwn(target, key)) {
          return Reflect.get(target, key);
        }
        if (!strict) return `«${key}»`;
        throw new Error(
          `prompt "${rendering}" reads ${key}, which its data does not carry`,
        );
      },
    });
  }
}

export function createPromptRegistry(
  sources: Record<string, PromptSource>,
  options: PromptRegistryOptions = {},
): PromptRegistry {
  const read =
    options.readFile ?? ((file: string) => readFileSync(file, "utf8"));
  const root = options.root ?? factoryRoot;
  const eta = new PromptEta({
    autoEscape: false,
    autoTrim: false,
    defaultExtension: ".md",
    varName: "it",
    useWith: false,
    functionHeader: FUNCTION_HEADER,
  });
  const functions = new Map<string, (data: PromptData) => string>();
  const unloadable = new Map<string, string>();
  let loaded = false;

  const resolve = (file: string): string =>
    path.isAbsolute(file)
      ? file
      : path.join(typeof root === "string" ? root : root(), file);

  // Every source at once, so a template can include any other by name — Eta
  // resolves an include against its own cache and nothing else. A source that
  // will not load is recorded rather than thrown, so one bad template costs
  // its own prompt and not the other seven.
  function load(): void {
    if (loaded) return;
    loaded = true;
    for (const [name, source] of Object.entries(sources)) {
      if (typeof source === "function") {
        functions.set(name, source);
        continue;
      }
      try {
        eta.loadTemplate(
          name,
          "template" in source ? source.template : read(resolve(source.file)),
        );
      } catch (err) {
        unloadable.set(name, String(err));
      }
    }
  }

  function names(): string[] {
    return Object.keys(sources).sort();
  }

  function renderTemplate(name: string, data: PromptData, strict: boolean) {
    eta.rendering = name;
    eta.strict = strict;
    try {
      return eta.render(name, data);
    } finally {
      eta.rendering = "";
      eta.strict = true;
    }
  }

  return {
    names,

    render(name, data) {
      load();
      const fn = functions.get(name);
      if (fn !== undefined) return fn(data);
      const unloaded = unloadable.get(name);
      if (unloaded !== undefined) {
        throw new Error(`prompt "${name}" could not be loaded: ${unloaded}`);
      }
      if (!Object.hasOwn(sources, name)) {
        throw new Error(
          `no prompt named "${name}" is registered — registered: ${names().join(", ")}`,
        );
      }
      return renderTemplate(name, data, true);
    },

    check() {
      load();
      const failures: PromptCheckFailure[] = [];
      for (const name of names()) {
        const unloaded = unloadable.get(name);
        if (unloaded !== undefined) {
          failures.push({ name, error: unloaded });
          continue;
        }
        // A function source is plain TypeScript the compiler already checks,
        // and calling it with no data would only report its own guards.
        if (functions.has(name)) continue;
        try {
          renderTemplate(name, {}, false);
        } catch (err) {
          failures.push({ name, error: String(err) });
        }
      }
      return failures;
    },
  };
}
