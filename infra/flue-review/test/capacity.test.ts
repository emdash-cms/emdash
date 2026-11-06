import { describe, expect, it } from "vitest";

import {
	CapacityExhaustedError,
	isCapacityError,
	withCapacityRetry,
} from "../.flue/lib/capacity.js";

function statusError(status: number, message: string): Error {
	return Object.assign(new Error(message), { status });
}

describe("isCapacityError", () => {
	it.each([
		["Workers AI capacity", new Error("AiError: 3040: Capacity temporarily exceeded")],
		[
			"Anthropic rate limit",
			new Error('429 {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}'),
		],
		[
			"Anthropic overload",
			new Error('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'),
		],
		["OpenAI rate limit", new Error("OpenAI API error: rate_limit_exceeded")],
		["503 overloaded", new Error("503 Service Unavailable: upstream overloaded")],
		["429 status", statusError(429, "Too Many Requests")],
		["529 status", statusError(529, "provider error")],
		["503 status reporting unavailability", statusError(503, "Service Unavailable")],
		[
			"a wrapped gateway rate limit",
			new Error("operation failed", { cause: new Error("AI Gateway: 429 rate limited") }),
		],
	])("retries %s", (_name, error) => {
		expect(isCapacityError(error)).toBe(true);
	});

	it.each([
		["a bad request", statusError(400, "invalid model")],
		["a missing model", new Error('404 {"error":{"type":"not_found_error"}}')],
		["an unexplained 503", statusError(503, "no route configured")],
		["an authentication failure", new Error("401 Unauthorized")],
	])("does not retry %s", (_name, error) => {
		expect(isCapacityError(error)).toBe(false);
	});
});

describe("withCapacityRetry", () => {
	it("retries an overloaded provider and returns the next success", async () => {
		let calls = 0;
		const retries: number[] = [];
		const result = await withCapacityRetry(
			async () => {
				calls++;
				if (calls === 1) throw statusError(529, "Overloaded");
				return "ok";
			},
			{ label: "test", baseDelayMs: 1, onRetry: ({ attempt }) => retries.push(attempt) },
		);
		expect(result).toBe("ok");
		expect(retries).toEqual([1]);
	});

	it("gives up after the attempt budget", async () => {
		await expect(
			withCapacityRetry(
				async () => {
					throw statusError(429, "rate limited");
				},
				{ label: "test", attempts: 2, baseDelayMs: 1 },
			),
		).rejects.toBeInstanceOf(CapacityExhaustedError);
	});

	it("does not retry other errors", async () => {
		let calls = 0;
		await expect(
			withCapacityRetry(
				async () => {
					calls++;
					throw new Error("invalid model");
				},
				{ label: "test", baseDelayMs: 1 },
			),
		).rejects.toThrow("invalid model");
		expect(calls).toBe(1);
	});
});
