import * as Tooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

/** A label with a dotted underline that explains itself on hover and keyboard focus. */
export function Hint({ label, tip }: { label: ReactNode; tip: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          className="cursor-help font-[inherit] underline decoration-zinc-400 decoration-dotted underline-offset-4"
        >
          {label}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          sideOffset={6}
          className="z-50 max-w-72 rounded-md border border-zinc-200 bg-white px-3 py-2 text-left text-xs font-normal text-zinc-700 shadow-md dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
        >
          {tip}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
