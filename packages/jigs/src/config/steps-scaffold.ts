import path from "node:path";

// The factory's steps/jigs.ts is scaffolded once and owned by the human from
// then on, so jigs never rewrites it. What jigs can still do is notice that it
// has grown a step this factory has no wrapper for — a step nobody can call,
// which is a build-clean, silent hole. The scaffold template is the one list
// of steps: a wrapper added there shows up in the `jigs init` offer and in the
// `jigs build` warning, and nothing else has to be told.

export const STEPS_FILE = path.join("steps", "jigs.ts");

interface Import {
  local: string;
  statement: string;
}

export interface StepWrapper {
  name: string;
  source: string;
  /** What this wrapper's body binds, split one name per statement. */
  imports: Import[];
}

// Top-level declarations only, which is all the template writes and all a
// wrapper can be: the closing brace of a formatted top-level function is the
// one `}` in column zero.
function declarations(source: string): { name: string; text: string }[] {
  const lines = source.split("\n");
  const found: { name: string; text: string }[] = [];
  for (let start = 0; start < lines.length; start += 1) {
    const match = /^export (?:async )?function (\w+)\(/.exec(
      lines[start] ?? "",
    );
    if (match === null) continue;
    let end = start;
    while (end < lines.length && lines[end] !== "}") end += 1;
    found.push({
      name: match[1] as string,
      text: lines.slice(start, end + 1).join("\n"),
    });
    start = end;
  }
  return found;
}

// One statement per bound name rather than the template's grouped imports: an
// appended block must not re-import a name the factory already has, and
// splitting them is what makes that a per-name decision.
function imports(source: string): Import[] {
  const found: Import[] = [];
  for (const statement of source.match(/^import [\s\S]*?;$/gm) ?? []) {
    const names = /\{([\s\S]*)\}/.exec(statement)?.[1];
    const from = /from\s+("[^"]+")/.exec(statement)?.[1];
    if (names === undefined || from === undefined) continue;
    const wholeStatementIsType = statement.startsWith("import type ");
    for (const raw of names.split(",")) {
      const parsed = /^(type\s+)?(\w+)(?:\s+as\s+(\w+))?$/.exec(raw.trim());
      if (parsed === null) continue;
      const [, asType, name, alias] = parsed;
      const kind = wholeStatementIsType || asType !== undefined ? "type " : "";
      const bound = alias === undefined ? name : `${name} as ${alias}`;
      found.push({
        local: alias ?? (name as string),
        statement: `import ${kind}{ ${bound} } from ${from};`,
      });
    }
  }
  return found;
}

const binds = (source: string, name: string) =>
  new RegExp(`\\b${name}\\b`).test(source);

/** Every `"use step"` wrapper the scaffold template declares, in file order. */
export function templateWrappers(template: string): StepWrapper[] {
  const bound = imports(template);
  return declarations(template)
    .filter((declaration) => declaration.text.includes('"use step"'))
    .map((declaration) => ({
      name: declaration.name,
      source: declaration.text,
      imports: bound.filter((entry) => binds(declaration.text, entry.local)),
    }));
}

/**
 * The wrappers the template has and this factory's file does not. Presence is
 * an exported binding of the same name: the name is half the step id, so a
 * factory that renamed one has not got that step, whatever it delegates to.
 */
export function missingWrappers(
  template: string,
  existing: string,
): StepWrapper[] {
  return templateWrappers(template).filter(
    (wrapper) =>
      !new RegExp(
        `^export (?:async function|function|const|let|var) ${wrapper.name}\\b`,
        "m",
      ).test(existing),
  );
}

/** What `jigs init` offers to append to a factory's steps/jigs.ts. */
export function appendBlock(missing: StepWrapper[], existing: string): string {
  const statements = [
    ...new Set(
      missing
        .flatMap((wrapper) => wrapper.imports)
        .filter((entry) => !binds(existing, entry.local))
        .map((entry) => entry.statement),
    ),
  ];
  return [
    "",
    "// Appended by a later `jigs init`: jigs grew these steps after this file",
    "// was scaffolded. Imports hoist, so the block works where it sits — move",
    "// it in with the rest whenever you like.",
    ...statements,
    "",
    ...missing.map((wrapper) => `${wrapper.source}\n`),
  ].join("\n");
}
