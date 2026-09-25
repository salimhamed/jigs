import type { ClaudeHarness, CodexHarness } from "../../../workflow/agents/harness-config.ts";

const JIGS_KEYS: readonly string[] = ["kind", "model", "mcpServers"];

// The provider settings a descriptor carries. The drivers spread these first
// and their policy last, and strip the policy keys here too, so a descriptor
// that skipped its constructor still cannot set one.
export function descriptorSettings<H extends ClaudeHarness | CodexHarness>(
  harness: H,
  policyKeys: readonly string[],
): Omit<H, "kind" | "model" | "mcpServers"> {
  return Object.fromEntries(
    Object.entries(harness).filter(
      ([key, value]) =>
        !JIGS_KEYS.includes(key) && !policyKeys.includes(key) && typeof value !== "function",
    ),
  ) as Omit<H, "kind" | "model" | "mcpServers">;
}
