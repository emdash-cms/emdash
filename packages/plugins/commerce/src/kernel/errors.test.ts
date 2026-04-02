import { describe, expect, it } from "vitest";
import {
	COMMERCE_ERRORS,
	COMMERCE_ERROR_WIRE_CODES,
	commerceErrorCodeToWire,
	type CommerceErrorCode,
} from "./errors.js";

const WIRE_PATTERN = /^[a-z][a-z0-9_]*$/;

describe("commerceErrorCodeToWire", () => {
	it("maps every internal code to a non-empty snake_case wire code", () => {
		for (const key of Object.keys(COMMERCE_ERRORS) as CommerceErrorCode[]) {
			const wire = commerceErrorCodeToWire(key);
			expect(wire).toMatch(WIRE_PATTERN);
			expect(wire.length).toBeGreaterThan(0);
		}
	});

	it("COMMERCE_ERROR_WIRE_CODES has exactly the same keys as COMMERCE_ERRORS", () => {
		expect(Object.keys(COMMERCE_ERROR_WIRE_CODES).sort()).toEqual(
			Object.keys(COMMERCE_ERRORS).sort(),
		);
	});

	it("returns known mappings for representative codes", () => {
		expect(commerceErrorCodeToWire("WEBHOOK_REPLAY_DETECTED")).toBe(
			"webhook_replay_detected",
		);
		expect(commerceErrorCodeToWire("ORDER_STATE_CONFLICT")).toBe(
			"order_state_conflict",
		);
	});
});
