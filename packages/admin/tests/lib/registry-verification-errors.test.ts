import { describe, expect, it } from "vitest";

import { ApiResponseError } from "../../src/lib/api/client";
import { registryVerificationErrorMessage } from "../../src/lib/api/registry";

describe("registry verification errors", () => {
	it("turns a missing signed profile extension into publisher guidance", () => {
		const error = new ApiResponseError(
			400,
			"RECORD_VERIFICATION_FAILED",
			"The signed repository extension is absent.",
			{ verificationCode: "PROFILE_EXTENSION_MISSING" },
		);

		expect(registryVerificationErrorMessage(error)).toBe(
			"This plugin cannot be installed because its publisher profile is missing valid verification metadata. Ask the publisher to republish it with the latest EmDash plugin CLI.",
		);
	});

	it("leaves unrelated API errors to the shared fallback", () => {
		const error = new ApiResponseError(404, "NOT_FOUND", "Not found");
		expect(registryVerificationErrorMessage(error)).toBeNull();
	});
});
