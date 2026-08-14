CREATE TABLE "anchor_contact_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"contact_endpoint_id" text NOT NULL,
	"version" integer NOT NULL,
	"key_id" text NOT NULL,
	"ciphertext" text NOT NULL,
	"initialization_vector" text NOT NULL,
	"authentication_tag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "anchor_contact_secrets_version_check" CHECK ("anchor_contact_secrets"."version" > 0),
	CONSTRAINT "anchor_contact_secrets_key_not_blank" CHECK (length(btrim("anchor_contact_secrets"."key_id")) > 0),
	CONSTRAINT "anchor_contact_secrets_ciphertext_not_blank" CHECK (length(btrim("anchor_contact_secrets"."ciphertext")) > 0)
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "lease_token" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "anchor_contact_secrets" ADD CONSTRAINT "anchor_contact_secrets_contact_endpoint_id_anchor_contact_endpoints_id_fk" FOREIGN KEY ("contact_endpoint_id") REFERENCES "public"."anchor_contact_endpoints"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "anchor_contact_secrets_version_uidx" ON "anchor_contact_secrets" USING btree ("contact_endpoint_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "anchor_contact_secrets_active_uidx" ON "anchor_contact_secrets" USING btree ("contact_endpoint_id") WHERE "anchor_contact_secrets"."retired_at" IS NULL;--> statement-breakpoint
CREATE INDEX "anchor_contact_secrets_key_idx" ON "anchor_contact_secrets" USING btree ("key_id");--> statement-breakpoint
ALTER TABLE "anchor_reviews" ADD CONSTRAINT "anchor_reviews_decision_check" CHECK ("anchor_reviews"."decision" IN ('approve_public', 'withhold'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_lease_token_check" CHECK ("notifications"."lease_token" >= 0);--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_lease_check" CHECK (("notifications"."lease_owner" IS NULL AND "notifications"."lease_expires_at" IS NULL) OR
          ("notifications"."lease_owner" IS NOT NULL AND "notifications"."lease_expires_at" IS NOT NULL));--> statement-breakpoint
CREATE TRIGGER anchor_contact_secrets_no_delete
BEFORE DELETE OR TRUNCATE ON public.anchor_contact_secrets
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.anchor_contact_secrets FROM PUBLIC;--> statement-breakpoint
COMMENT ON TABLE public.anchor_contact_secrets IS
  'ANC-03 encrypted, versioned webhook signing secrets; rotation retires a version without deleting history.';
