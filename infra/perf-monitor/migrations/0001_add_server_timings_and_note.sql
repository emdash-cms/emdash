-- Add columns for Server-Timing capture and free-form run notes.
--
-- cold_server_timings stores the parsed Server-Timing header from the cold
-- request as a JSON object keyed by timing name:
--   { "<name>": { "dur": <number>, "desc"?: <string> } }
-- Only the cold response is stored -- warm requests are aggregated into
-- medians, so keeping N server-timing blobs per route makes no sense.
--
-- note is a free-form label, primarily for manual triggers
-- (e.g. "pre-cold-start-fix baseline") but available for any source.
ALTER TABLE perf_results ADD COLUMN cold_server_timings TEXT;
ALTER TABLE perf_results ADD COLUMN note TEXT;
