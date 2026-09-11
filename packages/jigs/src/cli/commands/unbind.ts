import {
  readFactoryConfigText,
  removeBinding,
  writeFactoryConfigText,
} from "../../config/factory-config.ts";
import { locateFactoryRoot } from "../../config/factory-root.ts";
import { bindingDir } from "../../steps/worktree/layout.ts";

export interface UnbindDeps {
  cwd: string;
  out: (line: string) => void;
}

export function unbindRepo(name: string, deps: UnbindDeps): void {
  const factoryRoot = locateFactoryRoot(deps.cwd);
  const text = readFactoryConfigText(factoryRoot);
  writeFactoryConfigText(factoryRoot, removeBinding(text, name));
  deps.out(`unbound ${name}`);
  // Offline command, no view of live runs: deleting hundreds of megabytes here
  // would be a guess about whether a worktree still holds them.
  deps.out(
    `the clone stays at ${bindingDir({ factoryRoot, bindingName: name })} — rm -rf it to reclaim the disk`,
  );
}
