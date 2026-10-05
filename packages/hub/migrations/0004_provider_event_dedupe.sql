ALTER TABLE "provider_events" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_app_dedupe_key" UNIQUE("app_id","dedupe_key");