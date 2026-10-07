import type { Provider } from "@jigs-ai/hub-protocol";
import { providerNames } from "../../src/provider-names.ts";

const initials: Record<Provider, string> = {
  github: "GH",
  linear: "LN",
  slack: "SL",
  pagerduty: "PD",
};

/** A provider's initials in a small box, with its name for screen readers and on hover. */
export function ProviderInitials({ provider }: { provider: Provider }) {
  return (
    <abbr
      title={providerNames[provider]}
      className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs font-semibold no-underline dark:bg-zinc-800"
    >
      {initials[provider]}
    </abbr>
  );
}

/** What a Linear app's name means, said wherever an admin sets it. */
export const linearNameHint =
  "Match the app's name in Linear: people @mention it by that name, and agents are told it is their own. You can rename the app in Linear's settings any time.";
