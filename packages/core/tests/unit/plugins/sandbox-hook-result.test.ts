import { describe, expect, it } from "vitest";

import {
	MAX_SANDBOX_SAVE_REJECTION_REASON_LENGTH,
	inspectSandboxHookResult,
} from "../../../src/plugins/sandbox/hook-result.js";

describe("sandbox hook result envelope", () => {
	it("accepts a bounded SAVE_REJECTED reason", () => {
		expect(
			inspectSandboxHookResult({
				__emdashSandboxHookResult: true,
				version: 1,
				error: { code: "SAVE_REJECTED", reason: "  Add a summary  " },
			}),
		).toEqual({
			kind: "error",
			error: { code: "SAVE_REJECTED", reason: "Add a summary" },
		});
	});

	it.each([
		["empty", ""],
		["whitespace-only", "   \n"],
		["overlong", "x".repeat(MAX_SANDBOX_SAVE_REJECTION_REASON_LENGTH + 1)],
	])("rejects a %s reason", (_label, reason) => {
		expect(
			inspectSandboxHookResult({
				__emdashSandboxHookResult: true,
				version: 1,
				error: { code: "SAVE_REJECTED", reason },
			}),
		).toEqual({ kind: "malformed" });
	});

	it.each([
		{ __emdashSandboxHookResult: true, version: 2, error: { code: "SAVE_REJECTED", reason: "No" } },
		{ __emdashSandboxHookResult: true, version: 1, error: { code: "UNKNOWN", reason: "No" } },
		{ __emdashSandboxHookResult: true, version: 1, error: { code: "SAVE_REJECTED" } },
		{ __emdashSandboxHookResult: true, version: 1, error: "SAVE_REJECTED" },
		{
			__emdashSandboxHookResult: false,
			version: 1,
			error: { code: "SAVE_REJECTED", reason: "No" },
		},
	])("rejects malformed or unknown envelopes", (value) => {
		expect(inspectSandboxHookResult(value)).toEqual({ kind: "malformed" });
	});

	it("leaves ordinary hook return values alone", () => {
		expect(inspectSandboxHookResult({ title: "Edited" })).toEqual({ kind: "value" });
	});
});
