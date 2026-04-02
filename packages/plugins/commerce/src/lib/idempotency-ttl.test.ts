import { describe, expect, it } from "vitest";

import { COMMERCE_LIMITS } from "../kernel/limits.js";
import { isIdempotencyRecordFresh } from "./idempotency-ttl.js";

describe("isIdempotencyRecordFresh", () => {
	it("returns false for invalid timestamps", () => {
		expect(isIdempotencyRecordFresh("not-a-date", Date.now())).toBe(false);
	});

	it("returns false when older than TTL", () => {
		const old = new Date(Date.now() - COMMERCE_LIMITS.idempotencyRecordTtlMs - 60_000).toISOString();
		expect(isIdempotencyRecordFresh(old, Date.now())).toBe(false);
	});

	it("returns true inside TTL window", () => {
		const recent = new Date(Date.now() - 60_000).toISOString();
		expect(isIdempotencyRecordFresh(recent, Date.now())).toBe(true);
	});
});
