import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";
import { input } from "./ui.ts";

/** A native select with its own arrow, since the browser's sits against the right border. */
export function Select(props: ComponentProps<"select">) {
  return (
    <span className="relative inline-flex">
      <select {...props} className={`${input} appearance-none pr-9`} />
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-zinc-500"
      />
    </span>
  );
}
