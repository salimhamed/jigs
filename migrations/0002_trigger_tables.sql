CREATE TABLE "jigs_triggers" (
  "factory" text NOT NULL,
  "trigger" text NOT NULL,
  "occurrence" text NOT NULL,
  "state" text NOT NULL,
  "inputs" jsonb NOT NULL,
  "attribute" text NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  "first_attempted_at" timestamptz,
  "attempted_at" timestamptz,
  "cancelled_run_ids" jsonb,
  "run_id" text,
  "started_at" timestamptz,
  "duplicate_run_ids" jsonb,
  "report" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("factory", "trigger", "occurrence")
);
--> statement-breakpoint
CREATE TABLE "jigs_trigger_markers" (
  "factory" text NOT NULL,
  "trigger" text NOT NULL,
  "enabled_at" timestamptz NOT NULL,
  "polled_through" timestamptz NOT NULL,
  PRIMARY KEY ("factory", "trigger")
);
