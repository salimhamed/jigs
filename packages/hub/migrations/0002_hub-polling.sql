CREATE TABLE "poll_markers" (
	"installation_id" uuid NOT NULL,
	"poller" text NOT NULL,
	"marker" text,
	CONSTRAINT "poll_markers_installation_id_poller_pk" PRIMARY KEY("installation_id","poller")
);
--> statement-breakpoint
ALTER TABLE "provider_events" ADD COLUMN "origin" text DEFAULT 'provider' NOT NULL;--> statement-breakpoint
ALTER TABLE "poll_markers" ADD CONSTRAINT "poll_markers_installation_id_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("id") ON DELETE cascade ON UPDATE no action;