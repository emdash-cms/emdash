import { describe, expect, it } from "vitest";

import {
	describeModerationLabel,
	describeRegistryModerationError,
	evaluatePackageModeration,
	isModerationBlocking,
	RegistryModerationBlockError,
	type RegistryPackageView,
} from "../../src/lib/api/registry";

describe("describeModerationLabel", () => {
	it("returns localized display text for a known value", () => {
		const { name, description } = describeModerationLabel("malware");
		expect(name).toBe("Malware");
		expect(description).toEqual(expect.any(String));
		expect(description).not.toBeNull();
	});

	it("falls back to the raw value with no description for an unmapped value", () => {
		const { name, description } = describeModerationLabel("some-future-label-value");
		expect(name).toBe("some-future-label-value");
		expect(description).toBeNull();
	});
});

function makePackage(overrides: Partial<RegistryPackageView> = {}): RegistryPackageView {
	return {
		uri: "at://did:plc:acme/com.emdashcms.experimental.package.profile/myplugin",
		cid: "bafypkgcid",
		did: "did:plc:acme",
		slug: "myplugin",
		indexedAt: "2025-01-01T00:00:00Z",
		labels: [],
		profile: null,
		...overrides,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture cast to the validated view shape
	} as any;
}

describe("evaluatePackageModeration", () => {
	it("blocks a package carrying a publisher-scope takedown label", () => {
		const pkg = makePackage({
			labels: [
				{
					ver: 1,
					src: "did:plc:labeler",
					uri: "did:plc:acme",
					val: "!takedown",
					cts: "2025-01-01T00:00:00Z",
				},
				// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw label fixture
			] as any,
		});
		const moderation = evaluatePackageModeration(pkg, [{ did: "did:plc:labeler", redact: false }]);
		expect(isModerationBlocking(moderation)).toBe(true);
		expect(moderation.blockingLabels).toContain("!takedown");
	});

	it("does not block a clean package", () => {
		const pkg = makePackage();
		const moderation = evaluatePackageModeration(pkg, [{ did: "did:plc:labeler", redact: false }]);
		expect(isModerationBlocking(moderation)).toBe(false);
	});
});

describe("describeRegistryModerationError", () => {
	it("renders a localized headline plus the localized blocking label names for RELEASE_BLOCKED", () => {
		const error = new RegistryModerationBlockError("RELEASE_BLOCKED", "raw server message", {
			reasonCodes: ["manual-block"],
			blockingLabels: ["malware"],
		});
		expect(describeRegistryModerationError(error)).toBe(
			"This release is blocked and can't be installed.\nMalware",
		);
	});

	it("renders the RELEASE_YANKED headline", () => {
		const error = new RegistryModerationBlockError("RELEASE_YANKED", "raw server message", {
			reasonCodes: ["manual-block"],
			blockingLabels: ["security-yanked"],
		});
		expect(describeRegistryModerationError(error)).toBe(
			"This release was withdrawn and can't be installed.\nSecurity yanked",
		);
	});

	it("returns null for any other error, keeping the generic fallback", () => {
		expect(describeRegistryModerationError(new Error("network error"))).toBeNull();
		expect(describeRegistryModerationError(undefined)).toBeNull();
	});
});
