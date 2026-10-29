-- CreateIndex
CREATE INDEX "communication_events_communication_id_idx" ON "communication_events"("communication_id");

-- CreateIndex
CREATE INDEX "communications_campaign_id_idx" ON "communications"("campaign_id");

-- CreateIndex
CREATE INDEX "communications_customer_id_idx" ON "communications"("customer_id");

-- CreateIndex
CREATE INDEX "orders_customer_id_idx" ON "orders"("customer_id");
