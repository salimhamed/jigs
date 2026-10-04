CREATE TABLE "jigs_worktrees" (
  "path" text PRIMARY KEY,
  "branch" text NOT NULL,
  "owner_run_id" text NOT NULL,
  "state" text NOT NULL,
  "repo_dir" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
