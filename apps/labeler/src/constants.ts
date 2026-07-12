/**
 * Protocol-level constants for the labeler's own Jetstream discovery
 * subscription. Mirrors `apps/aggregator/src/constants.ts`'s role, but the
 * labeler only assesses releases (spec §9.1) — not profiles or publisher
 * records, which the aggregator already verifies independently.
 */

import { NSID } from "@emdash-cms/registry-lexicons";

export const WANTED_COLLECTIONS = [NSID.packageRelease] as const;
