/** A timestamp in the viewer's locale; the server renders it in its own, so hydration may differ. */
export function Time({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} suppressHydrationWarning>
      {new Date(iso).toLocaleString()}
    </time>
  );
}
