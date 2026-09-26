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
DROP TABLE "jigs_worktrees";
