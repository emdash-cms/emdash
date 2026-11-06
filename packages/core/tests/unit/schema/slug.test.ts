import { describe, expect, it } from "vitest";

import { isValidSchemaSlug, MAX_SCHEMA_SLUG_LENGTH } from "../../../src/schema/slug.js";

describe("isValidSchemaSlug", () => {
	it.each(["a", "post", "blog_posts", "a1", "a".repeat(MAX_SCHEMA_SLUG_LENGTH)])(
		"accepts %s",
		(slug) => {
			expect(isValidSchemaSlug(slug)).toBe(true);
		},
	);

	it.each([
		"",
		"0",
		"1a",
		"Post",
		"_post",
		"po.st",
		"po-st",
		"a".repeat(MAX_SCHEMA_SLUG_LENGTH + 1),
	])("rejects %j", (slug) => {
		expect(isValidSchemaSlug(slug)).toBe(false);
	});

	it("rejects non-strings", () => {
		expect(isValidSchemaSlug(undefined)).toBe(false);
		expect(isValidSchemaSlug(null)).toBe(false);
		expect(isValidSchemaSlug(42)).toBe(false);
	});
});
