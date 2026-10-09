import { existsSync } from "node:fs";
import path from "node:path";
import { setHubUrl } from "../../config/config-edit.ts";
import { readFactoryConfigText, writeFactoryConfigText } from "../../config/factory-config.ts";
import { setFactoryEnv } from "../../config/factory-env.ts";
import { locateFactoryRoot } from "../../config/factory-root.ts";
import { JigsError } from "../../errors.ts";
import { hint } from "../output.ts";

export interface HubConnectDeps {
  cwd: string;
  out: (line: string) => void;
}

/** Point the factory at its hub: the URL into `jigs.config.ts`, the token into `.env`. */
export function connectHub(url: string, token: string, deps: HubConnectDeps): void {
  const parsed = URL.parse(url);
  if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    throw new JigsError(
      `${url} is not a URL`,
      "pass the address you reach the hub at, for example https://hub.example.com",
    );
  }
  if (token.trim() === "") {
    throw new JigsError(
      "the factory token is empty",
      "copy the token the hub showed when you added this factory",
    );
  }
  const factoryRoot = locateFactoryRoot(deps.cwd);
  if (!existsSync(path.join(factoryRoot, ".env"))) {
    throw new JigsError(
      `no .env in ${factoryRoot}`,
      "copy .env.example, then connect again: `cp .env.example .env`",
    );
  }
  const text = readFactoryConfigText(factoryRoot);
  const updated = setHubUrl(text, url);
  if (updated !== text) writeFactoryConfigText(factoryRoot, updated);
  setFactoryEnv(factoryRoot, "JIGS_HUB_TOKEN", token.trim());
  deps.out(`hub set to ${url} in jigs.config.ts`);
  deps.out("JIGS_HUB_TOKEN set in .env");
  for (const line of ["", ...hint("to apply it, run:", "pnpm exec jigs up")]) deps.out(line);
}
