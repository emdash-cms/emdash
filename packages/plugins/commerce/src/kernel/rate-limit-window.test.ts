import { describe, expect, it } from "vitest";

import { nextRateLimitState } from "./rate-limit-window.js";

describe("nextRateLimitState", () => {
	const windowMs = 60_000;

	it("allows first request in empty window", () => {
		const r = nextRateLimitState(null, 1_000, 3, windowMs);
		expect(r.allowed).toBe(true);
		expect(r.bucket).toEqual({ count: 1, windowStartMs: 1_000 });
	});

	it("increments within window", () => {
		const b1 = nextRateLimitState(null, 1_000, 3, windowMs);
		const b2 = nextRateLimitState(b1.bucket, 2_000, 3, windowMs);
		const b3 = nextRateLimitState(b2.bucket, 3_000, 3, windowMs);
		expect(b3.allowed).toBe(true);
		expect(b3.bucket.count).toBe(3);
	});

	it("blocks when limit reached", () => {
		let bucket = nextRateLimitState(null, 0, 2, windowMs).bucket;
		bucket = nextRateLimitState(bucket, 100, 2, windowMs).bucket;
		const blocked = nextRateLimitState(bucket, 200, 2, windowMs);
		expect(blocked.allowed).toBe(false);
		expect(blocked.bucket.count).toBe(2);
	});

	it("resets after window elapses", () => {
		let bucket = nextRateLimitState(null, 0, 1, windowMs).bucket;
		bucket = nextRateLimitState(bucket, 100, 1, windowMs).bucket;
		expect(nextRateLimitState(bucket, 100, 1, windowMs).allowed).toBe(false);
		const fresh = nextRateLimitState(bucket, windowMs + 1, 1, windowMs);
		expect(fresh.allowed).toBe(true);
		expect(fresh.bucket.count).toBe(1);
	});

	it("resets exactly at window boundary", () => {
		const first = nextRateLimitState(null, 0, 1, windowMs).bucket;
		const second = nextRateLimitState(first, windowMs, 1, windowMs);
		expect(second.allowed).toBe(true);
		expect(second.bucket).toEqual({ count: 1, windowStartMs: windowMs });
	});

	it("blocks when window config is invalid", () => {
		const denied = nextRateLimitState({ count: 1, windowStartMs: 1_000 }, 2_000, 0, windowMs);
		expect(denied.allowed).toBe(false);
		expect(denied.bucket).toEqual({ count: 1, windowStartMs: 1_000 });
	});

	it("blocks when window size config is invalid", () => {
		const denied = nextRateLimitState({ count: 1, windowStartMs: 1_000 }, 2_000, 2, -1);
		expect(denied.allowed).toBe(false);
		expect(denied.bucket).toEqual({ count: 1, windowStartMs: 1_000 });
	});
});
