import { deliveriesByHour, webhooksByHour } from "../../src/activity.ts";
import { requireMember } from "../auth.server.ts";
import { HourlyChart } from "../components/hourly-chart.tsx";
import { PageHeader } from "../components/page.tsx";
import type { Route } from "./+types/home.ts";

export async function loader({ context, request }: Route.LoaderArgs) {
  const { organizationId } = await requireMember(context, request);
  const [webhooks, deliveries] = await Promise.all([
    webhooksByHour(context.db, organizationId),
    deliveriesByHour(context.db, organizationId),
  ]);
  return { webhooks, deliveries };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <div className="space-y-6">
      <PageHeader title="Overview" />
      <HourlyChart title="Webhooks received, last 24 h" activity={loaderData.webhooks} />
      <HourlyChart
        title="Messages delivered to factories, last 24 h"
        activity={loaderData.deliveries}
      />
    </div>
  );
}
