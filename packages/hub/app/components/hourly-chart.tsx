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

// Checked for color-vision deficiency on the page's light and dark backgrounds; the bars and
// swatches fill with currentColor.
const providerColors: Record<Provider, string> = {
  github: "text-[#2a78d6] dark:text-[#3987e5]",
  linear: "text-[#eb6834] dark:text-[#d95926]",
  slack: "text-[#1baf7a] dark:text-[#199e70]",
  pagerduty: "text-[#eda100] dark:text-[#c98500]",
};

/** A card with a bar per hour of the last 24 hours, stacked by provider, and each provider's total below it. */
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
        <div
          className="text-zinc-300 [--gap:white] dark:text-zinc-700 dark:[--gap:var(--color-zinc-950)]"
          style={{ height: CHART_HEIGHT }}
        >
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
                {providers.map((provider) => (
                  <Bar
                    key={provider}
                    dataKey={`byProvider.${provider}`}
                    name={providerNames[provider]}
                    stackId="providers"
                    fill="currentColor"
                    stroke="var(--gap)"
                    strokeWidth={1}
                    isAnimationActive={false}
                    className={providerColors[provider]}
                  />
                ))}
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
        {providers.map((provider) => (
          <div key={provider}>
            <dt className="flex items-center gap-1.5 text-zinc-500">
              <Swatch provider={provider} />
              {providerNames[provider]}
            </dt>
            <dd className="tabular-nums">
              {activity.byProvider[provider].toLocaleString("en-US")}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Swatch({ provider }: { provider: Provider }) {
  return <span className={`size-2.5 rounded-sm bg-current ${providerColors[provider]}`} />;
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
    <div className="space-y-1 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-900 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100">
      <div className="text-zinc-500">
        {time(0)} – {time(1)}
      </div>
      {providers.map((provider) => (
        <div key={provider} className="flex items-center gap-1.5">
          <Swatch provider={provider} />
          <span className="grow">{providerNames[provider]}</span>
          <span className="tabular-nums">{hour.byProvider[provider].toLocaleString("en-US")}</span>
        </div>
      ))}
      <div className="flex justify-between border-t border-zinc-200 pt-1 font-medium dark:border-zinc-800">
        <span>Total</span>
        <span className="tabular-nums">{hour.count.toLocaleString("en-US")}</span>
      </div>
    </div>
  );
}
