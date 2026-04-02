import { COMMERCE_LIMITS } from "./limits.js";

const PRINTABLE_ASCII = /^[\x21-\x7E]+$/;

/**
 * Validates client-supplied Idempotency-Key (header or body).
 * Does not hash — storage layer hashes with route + user scope.
 */
export function validateIdempotencyKey(key: string | undefined): key is string {
	if (key === undefined || key === "") return false;
	const len = key.length;
	if (len < COMMERCE_LIMITS.minIdempotencyKeyLength || len > COMMERCE_LIMITS.maxIdempotencyKeyLength) {
		return false;
	}
	return PRINTABLE_ASCII.test(key);
}
