import { describe, expect, expectTypeOf, it } from "vitest";

import {
	bindChallengeContext,
	decodeChallengeContext,
	defineChallengeContext,
	encodeChallengeContext,
} from "./challenge-context.js";
import type { SerializedChallengeContext } from "./challenge-context.js";

function parseObject(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Expected an object");
	}
	return value as Record<string, unknown>;
}

const approvalContext = defineChallengeContext("release-approval", 1, (value) => {
	const object = parseObject(value);
	if (typeof object.intentId !== "string" || object.action !== "approve") {
		throw new Error("Invalid approval context");
	}
	return { action: "approve" as const, intentId: object.intentId };
});

const enrolmentContext = defineChallengeContext("passkey-enrolment", 1, (value) => {
	const object = parseObject(value);
	if (typeof object.approverDid !== "string") throw new Error("Invalid enrolment context");
	return { approverDid: object.approverDid };
});

describe("challenge context", () => {
	it("round-trips typed context with deterministic serialization", () => {
		const first = encodeChallengeContext(approvalContext, {
			intentId: "intent_1",
			action: "approve",
		});
		const second = encodeChallengeContext(approvalContext, {
			action: "approve",
			intentId: "intent_1",
		});

		expect(first).toBe(second);
		expect(decodeChallengeContext(first, approvalContext)).toEqual({
			action: "approve",
			intentId: "intent_1",
		});
		expectTypeOf(first).toEqualTypeOf<SerializedChallengeContext<"release-approval">>();
		const binding = bindChallengeContext(approvalContext, {
			action: "approve",
			intentId: "intent_1",
		});
		expectTypeOf(binding.value.action).toEqualTypeOf<"approve">();

		// @ts-expect-error Ceremony brands prevent typed serialized values being interchanged.
		const wrongContext: SerializedChallengeContext<"passkey-enrolment"> = first;
		expect(wrongContext).toBe(first);
	});

	it("rejects malformed serialized values", () => {
		expect(() => decodeChallengeContext("not base64url!", approvalContext)).toThrow(
			/Malformed challenge context/,
		);
		expect(() =>
			decodeChallengeContext(Buffer.from("not json").toString("base64url"), approvalContext),
		).toThrow(/Malformed challenge context/);
	});

	it("rejects non-canonical serialized values", () => {
		const nonCanonical = Buffer.from(
			JSON.stringify({
				version: 1,
				type: "release-approval",
				context: { intentId: "intent_1", action: "approve" },
			}),
		).toString("base64url");

		expect(() => decodeChallengeContext(nonCanonical, approvalContext)).toThrow(
			/Malformed challenge context/,
		);
	});

	it("rejects version mismatches", () => {
		const versionTwo = defineChallengeContext("release-approval", 2, approvalContext.parse);
		const serialized = encodeChallengeContext(versionTwo, {
			action: "approve",
			intentId: "intent_1",
		});

		expect(() => decodeChallengeContext(serialized, approvalContext)).toThrow(
			/Challenge context version mismatch/,
		);
	});

	it("rejects ceremony type mismatches", () => {
		const serialized = encodeChallengeContext(enrolmentContext, {
			approverDid: "did:plc:approver",
		});

		expect(() => decodeChallengeContext(serialized, approvalContext)).toThrow(
			/Challenge context type mismatch/,
		);
	});

	it("validates decoded context with the codec", () => {
		const invalid = encodeChallengeContext(
			defineChallengeContext("release-approval", 1, (value) => value),
			{ action: "reject", intentId: "intent_1" },
		);

		expect(() => decodeChallengeContext(invalid, approvalContext)).toThrow(
			/Invalid approval context/,
		);
	});
});
