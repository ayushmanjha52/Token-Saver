-- OpenAI flex processing and long-context rates are separate price variants.
-- Each is priced only by its own rows; a call in a variant with no row goes
-- to the DLQ rather than being priced at the standard rate.
ALTER TABLE "model_prices" DROP CONSTRAINT "model_prices_tier_ck";--> statement-breakpoint
ALTER TABLE "model_prices" ADD CONSTRAINT "model_prices_tier_ck" CHECK ("tier" IN ('standard', 'fast', 'flex', 'long_context'));
