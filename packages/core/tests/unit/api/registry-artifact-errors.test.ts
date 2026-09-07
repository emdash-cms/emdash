import { describe, expect, it } from "vitest";

import { registryArtifactError } from "../../../src/api/handlers/registry.js";

describe("registry artifact error mapping", () => {
	it("reports artifact host and network failures as operation failures", () => {
		expect(registryArtifactError("HOST_REJECTED", "Host rejected", "install")).toMatchObject({
			success: false,
			error: { code: "INSTALL_FAILED", details: { verificationCode: "HOST_REJECTED" } },
		});
		expect(registryArtifactError("FETCH_FAILED", "Fetch failed", "update")).toMatchObject({
			success: false,
			error: { code: "UPDATE_FAILED", details: { verificationCode: "FETCH_FAILED" } },
		});
	});

	it("keeps malformed archives classified as invalid bundles", () => {
		expect(
			registryArtifactError("BUNDLE_INVALID_ARCHIVE", "Invalid archive", "install"),
		).toMatchObject({
			success: false,
			error: {
				code: "INVALID_BUNDLE",
				details: { verificationCode: "BUNDLE_INVALID_ARCHIVE" },
			},
		});
	});
});
