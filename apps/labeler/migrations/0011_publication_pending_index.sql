-- Partial covering index for the reconciliation publication-pending sweep
-- (`sweepPendingPublications`): it scans `publication_pending = 1` rows ordered
-- by `sequence` and filtered by `cts`. Without this the sweep full-scans the
-- monotonically growing `issued_labels` table every cron tick, risking a D1
-- query-timeout that would strand pending rows and block the rotation drain the
-- sweep exists to unblock. The partial predicate keeps the index to the tiny
-- set of un-broadcast rows; `(sequence, cts)` covers the SELECT, the cts filter,
-- and the sequence ordering.
CREATE INDEX idx_issued_labels_publication_pending
ON issued_labels(sequence, cts)
WHERE publication_pending = 1;
