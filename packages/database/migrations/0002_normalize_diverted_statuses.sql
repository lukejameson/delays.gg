-- Normalize all diversion statuses to "Diverted"
-- Run: psql $DATABASE_URL -f 0002_normalize_diverted_statuses.sql
-- Dry-run first: remove the UPDATE and just run the SELECT to review

-- Preview affected rows (DRY RUN)
SELECT id, flight_number, flight_date, departure_airport, arrival_airport, status
FROM flights
WHERE LOWER(status) LIKE '%divert%'
  AND status != 'Diverted'
ORDER BY flight_date DESC, scheduled_departure DESC
LIMIT 50;

-- Apply normalization
UPDATE flights
SET status = 'Diverted', updated_at = NOW()
WHERE LOWER(status) LIKE '%divert%'
  AND status != 'Diverted';

-- Normalize "Landed HH:MM" variants
UPDATE flights
SET status = 'Landed', updated_at = NOW()
WHERE status ~ '^Landed \d{2}:\d{2}$'
  AND status != 'Landed';

-- Normalize other non-standard statuses that should be standard
UPDATE flights
SET status = 'Scheduled', updated_at = NOW()
WHERE status IN (
  'Passengers moved to SI9211',
  'Pax have been moved onto SI2207 at 13:50'
);
