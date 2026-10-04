ALTER TABLE "jigs_trigger_markers" DROP COLUMN "polled_through";
--> statement-breakpoint
ALTER TABLE "jigs_trigger_markers" ADD COLUMN "cursor" jsonb;
