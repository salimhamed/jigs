import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Copy shipped source into a factory while preserving its existing files. */
export function copyFiles(
  source: string,
  destination: string,
  transform: { suffix: string; contents: (source: string) => string },
): { created: string[]; skipped: string[] } {
  const created: string[] = [];
  const skipped: string[] = [];
  function walk(relative: string) {
    for (const entry of readdirSync(path.join(source, relative), { withFileTypes: true })) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else if (entry.isFile() && file.endsWith(transform.suffix)) {
        const target = transform.suffix === "" ? file : file.slice(0, -transform.suffix.length);
        const output = path.join(destination, target);
        if (existsSync(output)) {
          skipped.push(target);
          continue;
        }
        mkdirSync(path.dirname(output), { recursive: true });
        writeFileSync(output, transform.contents(readFileSync(path.join(source, file), "utf8")));
        created.push(target);
      }
    }
  }
  walk("");
  return { created: created.sort(), skipped: skipped.sort() };
}

export function reportCopied(
  result: { created: string[]; skipped: string[] },
  out: (line: string) => void,
): void {
  for (const file of result.created) out(`created ${file}`);
  for (const file of result.skipped) out(`kept    ${file}`);
}
