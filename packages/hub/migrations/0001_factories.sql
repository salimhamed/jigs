CREATE TABLE "factories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_seen_version" text,
	"cursor" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "factories_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "factories_organization_name" UNIQUE("organization_id","name")
);
--> statement-breakpoint
CREATE TABLE "factory_messages" (
	"position" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "factory_messages_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"factory_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"provider_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "factories" ADD CONSTRAINT "factories_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factory_messages" ADD CONSTRAINT "factory_messages_factory_id_factories_id_fk" FOREIGN KEY ("factory_id") REFERENCES "public"."factories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factory_messages" ADD CONSTRAINT "factory_messages_provider_event_id_provider_events_id_fk" FOREIGN KEY ("provider_event_id") REFERENCES "public"."provider_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "factory_messages_factory_position_idx" ON "factory_messages" USING btree ("factory_id","position");--> statement-breakpoint
CREATE INDEX "factory_messages_provider_event_idx" ON "factory_messages" USING btree ("provider_event_id");--> statement-breakpoint
CREATE INDEX "factory_messages_created_at_idx" ON "factory_messages" USING btree ("created_at");