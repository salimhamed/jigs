import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const worktrees = pgTable("jigs_worktrees", {
  path: text("path").primaryKey(),
  branch: text("branch").notNull(),
  ownerRunId: text("owner_run_id").notNull(),
  state: text("state").notNull(),
  repoDir: text("repo_dir").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
