import { type FactoryContext, resolveFactoryContext } from "../config/factory-context.ts";
import { locateFactoryRoot } from "../config/factory-root.ts";

/** The factory a verb was typed in: the one around `cwd`, not necessarily the process's own. */
export function factoryContextAt(cwd: string): FactoryContext {
  return resolveFactoryContext(locateFactoryRoot(cwd));
}
