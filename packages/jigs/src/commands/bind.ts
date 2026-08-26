import { existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  parseFactoryConfig,
  readFactoryConfigText,
  upsertBinding,
  writeFactoryConfigText,
} from "../config/factory-config.ts";
import { locateFactoryRoot } from "../config/locate-factory.ts";
import {
  detectCopyFiles,
  generateTargetConfig,
  inferPostCreate,
  TARGET_CONFIG_FILE,
} from "../config/target-scaffold.ts";
import { CliError } from "../errors.ts";
import { assertCheckoutRoot, resolveRemoteUrl } from "../git.ts";
import { contractHome, expandHome } from "../paths.ts";

export const BINDING_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface BindDeps {
  cwd: string;
  home?: string;
  confirm?: (question: string) => Promise<boolean>;
  out: (line: string) => void;
}

export interface BindOptions {
  name?: string;
}

export interface BindResult {
  name: string;
  path: string;
  remote: string;
  factoryRoot: string;
  scaffolded: boolean;
}

export async function bindRepo(
  targetPath: string,
  deps: BindDeps,
  options: BindOptions = {},
): Promise<BindResult> {
  const factoryRoot = locateFactoryRoot(deps.cwd);
  const target = path.resolve(deps.cwd, expandHome(targetPath, deps.home));
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new CliError(`${targetPath} is not a directory`);
  }
  await assertCheckoutRoot(target);
  const { url } = await resolveRemoteUrl(target);

  const name = options.name ?? path.basename(target);
  if (!BINDING_NAME_PATTERN.test(name)) {
    throw new CliError(
      `invalid binding name ${JSON.stringify(name)}`,
      "names must match [A-Za-z0-9][A-Za-z0-9._-]* — pass --name to choose one",
    );
  }

  const text = readFactoryConfigText(factoryRoot);
  const config = parseFactoryConfig(text);
  const resolveBindingPath = (p: string) =>
    path.resolve(expandHome(p, deps.home));

  const existing = config.bindings[name];
  if (existing !== undefined && resolveBindingPath(existing.path) !== target) {
    throw new CliError(
      `${name} is already bound to ${existing.path}`,
      `bind under a different name: jigs bind ${targetPath} --name <n>`,
    );
  }
  const duplicate = Object.entries(config.bindings).find(
    ([boundName, binding]) =>
      boundName !== name && resolveBindingPath(binding.path) === target,
  );
  if (duplicate !== undefined) {
    deps.out(`note: ${target} is already bound as ${duplicate[0]}`);
  }
  if (existing !== undefined && existing.remote !== url) {
    deps.out(`remote pin updated: ${existing.remote} → ${url}`);
  }

  const storedPath = contractHome(target, deps.home);
  const updated = upsertBinding(text, name, { path: storedPath, remote: url });
  if (updated !== text) {
    writeFactoryConfigText(factoryRoot, updated);
  }
  deps.out(
    existing !== undefined
      ? `updated binding ${name} → ${storedPath}`
      : `bound ${name} → ${storedPath}`,
  );

  const scaffolded = await offerScaffold(target, deps);
  return { name, path: storedPath, remote: url, factoryRoot, scaffolded };
}

async function offerScaffold(target: string, deps: BindDeps): Promise<boolean> {
  const targetConfigPath = path.join(target, TARGET_CONFIG_FILE);
  if (existsSync(targetConfigPath)) return false;
  if (deps.confirm === undefined) {
    deps.out(
      `note: skipping ${TARGET_CONFIG_FILE} scaffold offer (non-interactive)`,
    );
    return false;
  }
  const content = generateTargetConfig(
    detectCopyFiles(target),
    inferPostCreate(target),
  );
  deps.out(`no ${TARGET_CONFIG_FILE} in the target repo — proposed content:`);
  deps.out(content);
  if (!(await deps.confirm(`write ${targetConfigPath}?`))) return false;
  writeFileSync(targetConfigPath, content, { flag: "wx" });
  return true;
}
