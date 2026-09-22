import { describe, expect, it } from "vitest";

import {
	MAX_CONTENT_POLICY_REASON_LENGTH,
	inspectContentPolicyDecision,
} from "../../../src/plugins/content-policy.js";

describe("inspectContentPolicyDecision", () => {
	it("allows an omitted decision and normalizes a bounded plain-text reason", () => {
		expect(inspectContentPolicyDecision(undefined)).toEqual({ kind: "allow" });
		expect(
			inspectContentPolicyDecision({ cancel: true, reason: "  Approval is required.  " }),
		).toEqual({ kind: "cancel", reason: "Approval is required." });
	});

	it.each([
		null,
		false,
		{ cancel: false, reason: "No" },
		{ cancel: true, reason: "" },
		{ cancel: true, reason: "No", retryable: false },
		{ cancel: true, reason: "Contains\u0000control" },
		{ cancel: true, reason: "x".repeat(MAX_CONTENT_POLICY_REASON_LENGTH + 1) },
	])("rejects malformed or unsafe decisions", (decision) => {
		expect(inspectContentPolicyDecision(decision)).toEqual({ kind: "invalid" });
	});

	it("counts Unicode code points rather than UTF-16 units", () => {
		expect(
			inspectContentPolicyDecision({
				cancel: true,
				reason: "😀".repeat(MAX_CONTENT_POLICY_REASON_LENGTH),
			}),
		).toMatchObject({ kind: "cancel" });
	});

	it("requires own decision fields", () => {
		const inherited = Object.create({ cancel: true, reason: "Inherited" });
		expect(inspectContentPolicyDecision(inherited)).toEqual({ kind: "invalid" });
	});
});
