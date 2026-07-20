CREATE TABLE "document_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"event" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_files" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"pdf" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"filename" text NOT NULL,
	"content_hash" text NOT NULL,
	"status" text NOT NULL,
	"route" text,
	"segment_pages" jsonb,
	"classifier" jsonb,
	"candidate" jsonb,
	"positioned_doc" jsonb,
	"result" jsonb,
	"markdown" text,
	"repairs" jsonb,
	"violations" jsonb,
	"vlm_attempted" boolean DEFAULT false NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"failed_constraints" jsonb,
	"failed_rules" jsonb,
	"classifier_features" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" text
);
--> statement-breakpoint
CREATE TABLE "vendor_template_ibans" (
	"iban" text PRIMARY KEY NOT NULL,
	"template_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ust_id_nr" text,
	"steuernummer" text,
	"name_hash" text,
	"template" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_templates_ust_id_nr_unique" UNIQUE("ust_id_nr"),
	CONSTRAINT "vendor_templates_steuernummer_unique" UNIQUE("steuernummer")
);
--> statement-breakpoint
ALTER TABLE "document_events" ADD CONSTRAINT "document_events_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_template_ibans" ADD CONSTRAINT "vendor_template_ibans_template_id_vendor_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."vendor_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_events_doc_idx" ON "document_events" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "documents_status_idx" ON "documents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "documents_content_hash_idx" ON "documents" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "documents_parent_idx" ON "documents" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "escalations_doc_idx" ON "escalations" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "vendor_templates_name_hash_idx" ON "vendor_templates" USING btree ("name_hash");