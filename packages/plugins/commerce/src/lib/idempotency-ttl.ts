import { COMMERCE_LIMITS } from "../kernel/limits.js";

/**
 * Returns true when an idempotency record is still within its TTL window.
 */
export function isIdempotencyRecordFresh(createdAtIso: string, nowMs: number): boolean {
	const t = Date.parse(createdAtIso);
	if (!Number.isFinite(t)) return false;
	return nowMs - t < COMMERCE_LIMITS.idempotencyRecordTtlMs;
}
