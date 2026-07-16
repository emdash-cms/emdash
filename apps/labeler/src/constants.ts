/**
 * Protocol-level constants for the labeler's own Jetstream discovery
 * subscription. Mirrors `apps/aggregator/src/constants.ts`'s role, but the
 * labeler only assesses releases (spec §9.1) — not profiles or publisher
 * records, which the aggregator already verifies independently.
 */

import { NSID } from "@emdash-cms/registry-lexicons";

export const WANTED_COLLECTIONS = [NSID.packageRelease] as const;

/**
 * Confirmation-send rate limits (plan W10.5). Versioned as a set: bump together
 * if the double-opt-in throttle is retuned. The per-ADDRESS limit is a LIFETIME
 * cap — a confirmation mail reaches an address at most once ever — enforced
 * atomically by the confirmation delivery-row claim, so it needs no interval
 * constant. The per-DID gate below is the remaining tunable: at most
 * `CONFIRM_DID_MAX_DISTINCT_RECIPIENTS` DISTINCT recipients in a
 * `CONFIRM_DID_WINDOW_MS` rolling window per publisher DID
 * (`notification_confirm_ledger`), capping a hostile DID naming many distinct
 * `victim@x` addresses — the amplification the per-address cap cannot see.
 */
export const CONFIRM_RATE_LIMIT_VERSION = 1;
export const CONFIRM_DID_WINDOW_MS = 24 * 60 * 60 * 1000;
export const CONFIRM_DID_MAX_DISTINCT_RECIPIENTS = 10;

/**
 * Delivery retry-sweep tunables (plan W10.5 slice 2). Versioned as a set: bump
 * together if the retry posture is retuned. The 5-minute cron is the natural
 * backoff interval — each pass re-drives every `failed` row (and every crashed
 * `pending` row older than {@link NOTIFICATION_STUCK_PENDING_MS}) once, capped at
 * {@link NOTIFICATION_MAX_SEND_ATTEMPTS} attempts before a row is abandoned to
 * `undeliverable` (which clears plaintext and, for a confirmation, reopens the
 * lifetime cap so the channel is not silently foreclosed). Terminal rows older
 * than {@link NOTIFICATION_RETENTION_MS} are pruned; a `sent` confirmation row is
 * kept (it holds the lifetime cap and carries no plaintext).
 */
export const NOTIFICATION_SWEEP_VERSION = 1;
export const NOTIFICATION_MAX_SEND_ATTEMPTS = 5;
export const NOTIFICATION_STUCK_PENDING_MS = 15 * 60 * 1000;
export const NOTIFICATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const NOTIFICATION_SWEEP_BATCH = 200;
