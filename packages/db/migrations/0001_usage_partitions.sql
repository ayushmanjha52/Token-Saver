-- Creates monthly usage_events partitions from last month through
-- `months_ahead`. Month arithmetic runs on UTC wall-clock timestamps and is
-- converted to timestamptz afterwards: adding a month to a timestamptz uses
-- the session time zone, which in a non-UTC session would put partition
-- bounds at local midnight and misfile events near the boundary.
CREATE OR REPLACE FUNCTION tokengrid_ensure_usage_partitions(months_ahead integer)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  base timestamp := date_trunc('month', now() AT TIME ZONE 'UTC');
  i integer;
  lo timestamp;
  hi timestamp;
BEGIN
  -- Serialise concurrent callers (several workers starting at once);
  -- CREATE TABLE IF NOT EXISTS alone still races on the catalog.
  PERFORM pg_advisory_xact_lock(hashtext('tokengrid_ensure_usage_partitions'));
  FOR i IN -1..months_ahead LOOP
    lo := base + make_interval(months => i);
    hi := base + make_interval(months => i + 1);
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF usage_events FOR VALUES FROM (%L) TO (%L)',
      'usage_events_' || to_char(lo, 'YYYY_MM'),
      lo AT TIME ZONE 'UTC',
      hi AT TIME ZONE 'UTC'
    );
  END LOOP;
END;
$$;
