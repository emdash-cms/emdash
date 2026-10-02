import { describe, expect, it } from "vitest";

import { decodeSlug } from "../../../src/utils/slugify.js";

describe("decodeSlug", () => {
	it("returns undefined for empty or undefined input", () => {
		expect(decodeSlug(undefined)).toBeUndefined();
		expect(decodeSlug("")).toBeUndefined();
	});

	it("decodes valid percent-encoded Unicode", () => {
		expect(decodeSlug("%e0%b0%ae%e0%b1%87%e0%b0%b7-%e0%b0%b0%e0%b0%be%e0%b0%b8%e0%b0%bf")).toBe(
			"మేష-రాసి",
		);
	});

	it("passes through unencoded plain text", () => {
		expect(decodeSlug("hello-world")).toBe("hello-world");
	});

	it("returns undefined for malformed percent-escapes", () => {
		expect(decodeSlug("%c0")).toBeUndefined();
		expect(decodeSlug("%zz")).toBeUndefined();
		expect(decodeSlug("trailing%")).toBeUndefined();
	});
});
