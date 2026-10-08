import { Info } from "lucide-react";
import type { ReactNode } from "react";

/** A boxed aside that gives background the reader needs before going on. */
export function Callout({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2.5 rounded-lg border border-sky-200 bg-sky-50 px-3.5 py-3 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950/50 dark:text-sky-200">
      <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}
