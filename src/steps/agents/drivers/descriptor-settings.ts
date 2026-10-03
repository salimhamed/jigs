import type { ClaudeHarness, CodexHarness } from "../../../workflow/agents/harness-config.ts";

const JIGS_KEYS = ["kind", "model", "mcpServers", "github", "skills"] as const;

// The provider settings a descriptor carries. The drivers spread these first
// and their policy last, and strip the policy keys here too, so a descriptor
// that skipped its constructor still cannot set one.
export function descriptorSettings<H extends ClaudeHarness | CodexHarness>(
  harness: H,
  policyKeys: readonly string[],
): Omit<H, (typeof JIGS_KEYS)[number]> {
  const jigsKeys: readonly string[] = JIGS_KEYS;
  return Object.fromEntries(
    Object.entries(harness).filter(
      ([key, value]) =>
        !jigsKeys.includes(key) && !policyKeys.includes(key) && typeof value !== "function",
    ),
  ) as Omit<H, (typeof JIGS_KEYS)[number]>;
}
