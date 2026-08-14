DROP INDEX "anchor_domains_domain_uidx";--> statement-breakpoint
DROP INDEX "anchors_network_name_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "anchor_domains_anchor_domain_uidx" ON "anchor_domains" USING btree ("anchor_id","domain");--> statement-breakpoint
CREATE INDEX "anchors_network_name_idx" ON "anchors" USING btree ("network_id","name");