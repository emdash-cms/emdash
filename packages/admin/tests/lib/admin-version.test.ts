import { describe, expect, it } from "vitest";

import { formatAdminVersion } from "../../src/lib/admin-version.js";

describe("formatAdminVersion", () => {
	it("uses the EmDash product name by default", () => {
		expect(formatAdminVersion("1.2.3", "abc123")).toBe("EmDash v1.2.3 (abc123)");
	});

	it("supports a custom footer label", () => {
		expect(formatAdminVersion("1.2.3", undefined, "Agency CMS")).toBe("Agency CMS v1.2.3");
	});

	it("supports showing the version without a footer label", () => {
		expect(formatAdminVersion("1.2.3", undefined, false)).toBe("v1.2.3");
	});
});
