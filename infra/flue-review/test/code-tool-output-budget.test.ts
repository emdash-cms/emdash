import { describe, expect, it } from "vitest";

import {
	MAX_CODE_TOOL_OUTPUT_BYTES,
	assertCodeToolOutputWithinBudget,
	formatCodeToolOutput,
} from "../.flue/lib/code-tool-output-budget.js";

describe("assertCodeToolOutputWithinBudget", () => {
	it("accepts the staged review diff below the output budget", () => {
		expect(() =>
			assertCodeToolOutputWithinBudget("x".repeat(MAX_CODE_TOOL_OUTPUT_BYTES)),
		).not.toThrow();
	});

	it("rejects oversized output with targeted retry guidance", () => {
		expect(() =>
			assertCodeToolOutputWithinBudget("x".repeat(MAX_CODE_TOOL_OUTPUT_BYTES + 1)),
		).toThrow(/slice.*search/s);
	});

	it("measures UTF-8 bytes", () => {
		const value = "é".repeat(MAX_CODE_TOOL_OUTPUT_BYTES / 2 + 1);
		expect(value.length).toBeLessThan(MAX_CODE_TOOL_OUTPUT_BYTES);
		expect(() => assertCodeToolOutputWithinBudget(value)).toThrow(/262146 bytes/);
	});

	it("includes logs in the output budget", () => {
		expect(() => formatCodeToolOutput("ok", ["x".repeat(100)], 100)).toThrow(/117 bytes/);
	});

	it("allows a smaller targeted result after rejecting a full-file result", () => {
		expect(() => formatCodeToolOutput("x".repeat(101), undefined, 100)).toThrow();
		expect(formatCodeToolOutput("x".repeat(100), undefined, 100)).toBe("x".repeat(100));
	});
});
