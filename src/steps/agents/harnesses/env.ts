import { readFactoryConfig } from "../../../config/factory-config.ts";
import { factoryRoot } from "../../../config/factory-root.ts";

// Every harness process gets these when the service has them, and nothing else
// unless its driver names it or the factory declares it in jigs.config.ts.
export const BASE_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TMPDIR",
  // Relocated config, caches and logins; the runtime dir holds the session's
  // sockets, such as the D-Bus bus a keyring is reached through.
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  // Reaching model providers from behind a proxy or a private CA.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

const isLocale = (name: string) => name.startsWith("LC_");

export function stringEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) clean[key] = value;
  }
  return clean;
}

// Built from empty: the base set, then exactly the names given.
export function harnessEnv(
  names: readonly string[],
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  const keep = (name: string) => {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  };
  for (const name of BASE_ENV) keep(name);
  for (const name of Object.keys(source)) if (isLocale(name)) keep(name);
  for (const name of names) keep(name);
  return env;
}

// What this factory declares under agents.env. Steps and checks both read it
// here, so a check probes the environment its step will run under.
export function factoryAgentEnv(): readonly string[] {
  return readFactoryConfig(factoryRoot()).agents.env;
}
