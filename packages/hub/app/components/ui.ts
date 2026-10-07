export const button =
  "inline-flex items-center justify-center gap-2 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";

export const secondaryButton =
  "inline-flex items-center justify-center gap-2 rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800";

export const quietButton =
  "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100";

/** The button that starts something destructive, such as removing a factory. */
export const dangerOutlineButton =
  "inline-flex items-center gap-2 rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950";

export const dangerButton =
  "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950";

export const input =
  "rounded-md border border-zinc-300 bg-transparent px-2.5 py-1.5 text-sm dark:border-zinc-700";

/** A native select: room on the right for its arrow. */
export const select = `${input} pr-8`;

export const card = "rounded-lg border border-zinc-200 dark:border-zinc-800";

export const table =
  "w-full text-left text-sm [&_td]:px-4 [&_td]:py-2.5 [&_th]:px-4 [&_th]:py-2.5 [&_th]:font-medium [&_thead]:bg-zinc-50 [&_thead]:text-zinc-500 dark:[&_thead]:bg-zinc-900 [&_tbody_tr]:border-t [&_tbody_tr]:border-zinc-200 dark:[&_tbody_tr]:border-zinc-800";

export const link = "underline decoration-zinc-400 underline-offset-4 hover:decoration-current";

export const warningText = "text-amber-600 dark:text-amber-400";

export const errorText = "text-red-600 dark:text-red-400";

/** Opens on the provider's site, away from the hub. */
export const external = { target: "_blank", rel: "noreferrer" } as const;
