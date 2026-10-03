-- Value domains the application relies on. Enforced here as well so a manual
-- SQL fix cannot introduce a role or scope the code silently ignores.
ALTER TABLE "users" ADD CONSTRAINT "users_org_role_ck" CHECK ("org_role" IN ('member', 'admin'));--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_role_ck" CHECK ("role" IN ('member', 'manager'));--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_scope_ck" CHECK ("scope" IN ('key', 'user', 'org'));--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_limit_ck" CHECK ("limit_usd" >= 0);--> statement-breakpoint
ALTER TABLE "model_prices" ADD CONSTRAINT "model_prices_tier_ck" CHECK ("tier" IN ('standard', 'fast'));--> statement-breakpoint
ALTER TABLE "model_prices" ADD CONSTRAINT "model_prices_rates_ck" CHECK (
  "input_per_mtok" >= 0 AND "output_per_mtok" >= 0 AND "cache_read_per_mtok" >= 0
  AND "cache_write_5m_per_mtok" >= 0 AND "cache_write_1h_per_mtok" >= 0
);--> statement-breakpoint
ALTER TABLE "model_prices" ADD CONSTRAINT "model_prices_range_ck" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");--> statement-breakpoint

-- Price history is append-only, and every change must take effect in the
-- future. Ingest workers cache prices for up to 60 seconds; a row effective
-- "now" would be invisible to them for that long and the events in between
-- would be stamped with the superseded price, silently. Two minutes clears
-- the cache window. A deliberate backfill (initial catalog, a correction)
-- opts in per transaction with SET LOCAL tokengrid.allow_backdated_price = on
-- and is then responsible for re-pricing affected events.
CREATE OR REPLACE FUNCTION tokengrid_model_prices_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  backdate_ok boolean := coalesce(current_setting('tokengrid.allow_backdated_price', true), '') = 'on';
  horizon timestamptz := now() + interval '2 minutes';
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'model_prices rows are append-only; close a version by setting effective_to instead'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.model_id, NEW.tier, NEW.effective_from, NEW.input_per_mtok, NEW.output_per_mtok,
    NEW.cache_read_per_mtok, NEW.cache_write_5m_per_mtok, NEW.cache_write_1h_per_mtok, NEW.source
  ) IS DISTINCT FROM (
    OLD.model_id, OLD.tier, OLD.effective_from, OLD.input_per_mtok, OLD.output_per_mtok,
    OLD.cache_read_per_mtok, OLD.cache_write_5m_per_mtok, OLD.cache_write_1h_per_mtok, OLD.source
  ) THEN
    RAISE EXCEPTION 'model_prices rows are append-only; only effective_to may change'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT backdate_ok THEN
    IF TG_OP = 'INSERT' AND NEW.effective_from < horizon THEN
      RAISE EXCEPTION 'model_prices.effective_from must be at least 2 minutes in the future (workers cache prices for 60s); for a deliberate backfill SET LOCAL tokengrid.allow_backdated_price = on'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.effective_to IS NOT NULL AND NEW.effective_to IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.effective_to END)
       AND NEW.effective_to < horizon THEN
      RAISE EXCEPTION 'model_prices.effective_to must be at least 2 minutes in the future; for a deliberate backfill SET LOCAL tokengrid.allow_backdated_price = on'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "model_prices_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "model_prices"
FOR EACH ROW EXECUTE FUNCTION tokengrid_model_prices_guard();
