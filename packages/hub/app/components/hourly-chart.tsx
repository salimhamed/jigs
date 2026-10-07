import { type Provider, providers } from "@jigs-ai/hub-protocol";
import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  type TooltipValueType,
} from "recharts";
import type { HourlyActivity } from "../../src/activity.ts";
import { providerNames } from "../../src/provider-names.ts";
import { card } from "./ui.ts";

const CHART_HEIGHT = 160;

/** A card with a bar per hour of the last 24 hours, and the total for each provider below it. */
export function HourlyChart({ title, activity }: { title: string; activity: HourlyActivity }) {
  // Recharts measures the page, so the chart draws only in the browser.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <section className={card}>
      <div className="flex items-baseline justify-between border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
        <h2 className="font-semibold">{title}</h2>
        <span className="tabular-nums">{activity.total.toLocaleString("en-US")}</span>
      </div>
      <div className="space-y-1 px-5 pt-4 pb-3">
        <div className="text-zinc-300 dark:text-zinc-700" style={{ height: CHART_HEIGHT }}>
          {mounted && (
            <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
              <BarChart
                data={activity.hours}
                barCategoryGap={2}
                margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
              >
                <Tooltip
                  content={HourTooltip}
                  cursor={{ fill: "currentColor", opacity: 0.3 }}
                  isAnimationActive={false}
                />
                <Bar
                  dataKey="count"
                  fill="currentColor"
                  radius={[4, 4, 0, 0]}
                  minPointSize={2}
                  isAnimationActive={false}
                  className="text-zinc-400 dark:text-zinc-600"
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="flex justify-between text-xs text-zinc-500">
          <span>24 h ago</span>
          <span>12 h</span>
          <span>now</span>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-4 border-t border-zinc-200 px-5 py-3 text-sm sm:grid-cols-4 dark:border-zinc-800">
        {providers.map((provider: Provider) => (
          <div key={provider}>
            <dt className="text-zinc-500">{providerNames[provider]}</dt>
            <dd className="tabular-nums">
              {activity.byProvider[provider].toLocaleString("en-US")}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function HourTooltip({ active, payload }: TooltipContentProps<TooltipValueType, string | number>) {
  const hour = payload?.[0]?.payload as HourlyActivity["hours"][number] | undefined;
  if (!active || !hour) return null;
  const time = (offsetHours: number) =>
    new Date(new Date(hour.start).getTime() + offsetHours * 3_600_000).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  return (
    <div className="rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-900 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100">
      <div className="text-zinc-500">
        {time(0)} – {time(1)}
      </div>
      <div className="font-medium tabular-nums">{hour.count.toLocaleString("en-US")}</div>
    </div>
  );
}
