const STRIP_PATTERNS = [/^ANTHROPIC_/, /^AI_GATEWAY/, /^CLAUDE_CODE_/];
const STRIP_KEYS = new Set([
  "OPENAI_API_KEY",
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
]);

function shouldStrip(key: string): boolean {
  return (
    STRIP_KEYS.has(key) || STRIP_PATTERNS.some((pattern) => pattern.test(key))
  );
}

// Removes every API-key / gateway credential and parent-agent-session var, so
// the only credential a harness can reach is the subscription login on disk
// (claude.ai OAuth, ~/.codex/auth.json). Mutates env; returns what it removed.
export function stripApiCredentials(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const stripped: string[] = [];
  for (const key of Object.keys(env)) {
    if (shouldStrip(key)) {
      stripped.push(key);
      delete env[key];
    }
  }
  return stripped;
}

export function stringEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) clean[key] = value;
  }
  return clean;
}

// The exact environment an agent step runs under, as a plain string map.
// Shared with the preflight harness checks so a check and the step it guards
// cannot drift.
export function scrubbedEnv(
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: NodeJS.ProcessEnv = { ...base };
  stripApiCredentials(env);
  return stringEnv(env);
}
