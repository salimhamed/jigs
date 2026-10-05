ALTER TABLE "installations" ADD COLUMN "settings" jsonb;--> statement-breakpoint
ALTER TABLE "installations" ADD COLUMN "secrets" text;--> statement-breakpoint
ALTER TABLE "installations" ADD COLUMN "failure" text;