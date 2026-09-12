import { describe, expect, it } from "vitest";

import { formatRegistryPublicName, parseRegistryPublicName } from "../../src/lib/registry-identity";

describe("registry public names", () => {
	it("formats a verified publisher handle and package slug", () => {
		expect(formatRegistryPublicName("Example.COM", "my-gallery")).toBe("@example.com/my-gallery");
	});

	it("parses the canonical public-name form for exact search", () => {
		expect(parseRegistryPublicName("  @example.com/my-gallery  ")).toEqual({
			handle: "example.com",
			slug: "my-gallery",
		});
	});

	it("rejects incomplete and unsafe public names", () => {
		for (const value of [
			"example.com/my-gallery",
			"@example.com",
			"@example.com/My-Gallery",
			"@example.com/my/gallery",
			"@did:plc:publisher/my-gallery",
		]) {
			expect(parseRegistryPublicName(value)).toBeNull();
		}
	});
});
