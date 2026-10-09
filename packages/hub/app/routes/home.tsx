import { queuedByHour, webhooksByHour } from "../../src/activity.ts";
import { requireMember } from "../auth.server.ts";
import { HourlyChart } from "../components/hourly-chart.tsx";
import { PageHeader } from "../components/page.tsx";
import type { Route } from "./+types/home.ts";

export async function loader({ context, request }: Route.LoaderArgs) {
  const { organizationId } = await requireMember(context, request);
  const [webhooks, queued] = await Promise.all([
    webhooksByHour(context.db, organizationId),
    queuedByHour(context.db, organizationId),
  ]);
  return { webhooks, queued };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <div className="space-y-6">
      <PageHeader title="Overview" />
      <HourlyChart title="Webhooks received, last 24 h" activity={loaderData.webhooks} />
      <HourlyChart title="Events queued for factories, last 24 h" activity={loaderData.queued} />
    </div>
  );
}
