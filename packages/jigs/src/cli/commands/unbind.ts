import { existsSync } from "node:fs";
import { removeBinding } from "../../config/config-edit.ts";
import { readFactoryConfigText, writeFactoryConfigText } from "../../config/factory-config.ts";
import { currentFactoryContext } from "../../config/factory-context.ts";
import { bindingFilesDir, cloneDir } from "../../steps/workspaces/layout.ts";
import { detail, displayPath, hint } from "../output.ts";

export interface UnbindDeps {
  out: (line: string) => void;
}

export function unbindRepo(name: string, deps: UnbindDeps): void {
  const factoryRoot = currentFactoryContext().root;
  const text = readFactoryConfigText(factoryRoot);
  writeFactoryConfigText(factoryRoot, removeBinding(text, name));
  deps.out(`unbound ${name}`);
  // Offline command, no view of live runs: deleting hundreds of megabytes here
  // would be a guess about whether a worktree still holds them.
  const clone = displayPath(cloneDir({ factoryRoot, bindingName: name }));
  const bindingFiles = bindingFilesDir(factoryRoot, name);
  for (const line of [
    `the clone stays at ${clone}`,
    ...(existsSync(bindingFiles)
      ? [
          `kept ${displayPath(bindingFiles)} ${detail("it may hold secrets, so delete it yourself")}`,
        ]
      : []),
    ...hint("to reclaim the clone's disk space:", `rm -rf ${clone}`),
  ]) {
    deps.out(line);
  }
}
