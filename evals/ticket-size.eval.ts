import { ticketSize } from "../recipes/linear-ticket-to-pr/decisions.ts";
import { evalSite } from "./harness.ts";

const ticket = (title: string, description: string, brief: string) => ({
  ticket: `# ${title}\n\n${description}`,
  brief,
});

evalSite("ticket-size", {
  question: ticketSize,
  cutoff: 0.9,
  cases: [
    {
      name: "typo in a button",
      state: ticket(
        "Fix typo on checkout button",
        "The button says 'Chekout'.",
        "Change the label string in CheckoutButton.tsx.",
      ),
      expected: 0,
    },
    {
      name: "bump a timeout",
      state: ticket(
        "Raise the export job timeout to 10 minutes",
        "Exports over 5 minutes fail.",
        "Change EXPORT_TIMEOUT_MS in config/jobs.ts from 300000 to 600000.",
      ),
      expected: 0,
    },
    {
      name: "add a query filter",
      state: ticket(
        "Filter orders by status in the admin list",
        "Admins want to filter by pending, shipped, cancelled.",
        "Add a status query param to GET /admin/orders, pass it to OrdersRepo.list, add a select to the list page, and test both.",
      ),
      expected: 1,
    },
    {
      name: "new webhook integration",
      state: ticket(
        "Receive Stripe refund webhooks",
        "Refunds issued in Stripe should mark orders refunded.",
        "Add a signed webhook endpoint, a refund event handler that updates the order and ledger, idempotency by event id, and tests with recorded payloads.",
      ),
      expected: 2,
    },
    {
      name: "multi-tenant migration",
      state: ticket(
        "Make every table tenant-scoped",
        "We are moving to multi-tenancy. All data access must be scoped by tenant.",
        "Add tenant_id to 40 tables with backfill migrations, thread tenant context through every repository and background job, update auth middleware, and add row-level security.",
      ),
      expected: 3,
    },
    {
      name: "replace the ORM",
      state: ticket(
        "Replace TypeORM with Drizzle",
        "TypeORM is unmaintained.",
        "Port all entities, repositories, migrations and transaction handling across the monorepo's six services to Drizzle.",
      ),
      expected: 3,
    },
    {
      name: "add a log line",
      state: ticket(
        "Log the request id when payment fails",
        "Support can't correlate failures.",
        "Include requestId in the existing logger.error call in payments/charge.ts.",
      ),
      expected: 0,
    },
  ],
});
