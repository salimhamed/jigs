CREATE TABLE "jigs_resources" (
  "factory" text NOT NULL,
  "run_id" text NOT NULL,
  "kind" text NOT NULL,
  "identity" text NOT NULL,
  "url" text NOT NULL,
  "state" text NOT NULL,
  "reason" text,
  "attempts" integer NOT NULL DEFAULT 0,
  "repo_dir" text,
  "branch" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("factory", "run_id", "kind", "identity")
);
--> statement-breakpoint
CREATE TABLE "jigs_triggers" (
  "factory" text NOT NULL,
  "trigger" text NOT NULL,
  "occurrence" text NOT NULL,
  "state" text NOT NULL,
  "inputs" jsonb NOT NULL,
  "attribute" text NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  "attempted_at" timestamptz,
  "run_id" text,
  "started_at" timestamptz,
  "report" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("factory", "trigger", "occurrence")
);
--> statement-breakpoint
CREATE INDEX "jigs_triggers_attribute" ON "jigs_triggers" ("factory", "attribute");
--> statement-breakpoint
CREATE TABLE "jigs_trigger_markers" (
  "factory" text NOT NULL,
  "trigger" text NOT NULL,
  "enabled_at" timestamptz NOT NULL,
  PRIMARY KEY ("factory", "trigger")
);
