/**
 * Protocol-level constants for the labeler's own Jetstream discovery
 * subscription. Mirrors `apps/aggregator/src/constants.ts`'s role, but the
 * labeler only assesses releases (spec §9.1) — not profiles or publisher
 * records, which the aggregator already verifies independently.
 */

import { NSID } from "@emdash-cms/registry-lexicons";

export const WANTED_COLLECTIONS = [NSID.packageRelease] as const;

/**
 * Confirmation-send rate limits (plan W10.5). Versioned as a set: bump all three
 * together if the double-opt-in throttle is retuned. Two independent gates guard
 * the confirmation mail, the only send an unconfirmed (hence unverified) contact
 * can receive:
 *
 *   * per-ADDRESS — `CONFIRM_MIN_INTERVAL_MS` since the last confirmation to this
 *     recipient hash (`notification_contacts.last_confirm_sent_at_epoch_ms`). Caps
 *     how often one victim is re-mailed while they ignore the first message.
 *   * per-DID — at most `CONFIRM_DID_MAX_DISTINCT_RECIPIENTS` DISTINCT recipients
 *     in a `CONFIRM_DID_WINDOW_MS` rolling window per publisher DID
 *     (`notification_confirm_ledger`). Caps a hostile DID naming many distinct
 *     `victim@x` addresses — the amplification the per-address gate cannot see.
 */
export const CONFIRM_RATE_LIMIT_VERSION = 1;
export const CONFIRM_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const CONFIRM_DID_WINDOW_MS = 24 * 60 * 60 * 1000;
export const CONFIRM_DID_MAX_DISTINCT_RECIPIENTS = 10;
