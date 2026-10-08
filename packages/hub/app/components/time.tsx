const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
  ["second", 1],
];

/** How long ago a timestamp was, such as "12 seconds ago", with the full time on hover. */
export function TimeAgo({ iso }: { iso: string }) {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const [unit, size] = units.find(([, size]) => Math.abs(seconds) >= size) ?? ["second", 1];
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()} suppressHydrationWarning>
      {new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
        Math.round(seconds / size),
        unit,
      )}
    </time>
  );
}
