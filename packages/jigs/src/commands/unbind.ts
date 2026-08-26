import {
  readFactoryConfigText,
  removeBinding,
  writeFactoryConfigText,
} from "../config/factory-config.ts";
import { locateFactoryRoot } from "../config/locate-factory.ts";

export interface UnbindDeps {
  cwd: string;
  out: (line: string) => void;
}

export function unbindRepo(name: string, deps: UnbindDeps): void {
  const factoryRoot = locateFactoryRoot(deps.cwd);
  const text = readFactoryConfigText(factoryRoot);
  writeFactoryConfigText(factoryRoot, removeBinding(text, name));
  deps.out(`unbound ${name}`);
}
