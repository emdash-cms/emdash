import { describe, expect, it } from "vitest";

import { validateIdempotencyKey } from "./idempotency-key.js";

describe("validateIdempotencyKey", () => {
	it("rejects empty", () => {
		expect(validateIdempotencyKey(undefined)).toBe(false);
		expect(validateIdempotencyKey("")).toBe(false);
	});

	it("rejects too short", () => {
		expect(validateIdempotencyKey("123456789012345")).toBe(false); // 15
	});

	it("accepts 16-char printable", () => {
		expect(validateIdempotencyKey("abcdefghijklmnop")).toBe(true);
	});

	it("rejects non-printable", () => {
		expect(validateIdempotencyKey("abc\ndefghijklmnop")).toBe(false);
	});
});
