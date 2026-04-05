/**
 * Tests for WordPress import slug sanitization
 *
 * Regression test for emdash-cms/emdash#79: WordPress import crashes on
 * collections with hyphens in slug (e.g. Elementor `elementor-hf`).
 *
 * EmDash collection slugs now allow hyphens (`[a-z][a-z0-9_-]*`), so
 * WordPress post type slugs with hyphens pass through without conversion.
 * Only truly invalid characters (spaces, dots, etc.) are sanitized.
 */

import { describe, expect, it } from "vitest";

import {
	mapPostTypeToCollection,
	sanitizeSlug,
} from "../../../src/astro/routes/api/import/wordpress/analyze.js";

describe("sanitizeSlug", () => {
	it("preserves hyphens", () => {
		expect(sanitizeSlug("elementor-hf")).toBe("elementor-hf");
	});

	it("preserves multiple hyphens", () => {
		expect(sanitizeSlug("my-custom-type")).toBe("my-custom-type");
	});

	it("strips leading non-letter characters", () => {
		expect(sanitizeSlug("123abc")).toBe("abc");
		expect(sanitizeSlug("_foo")).toBe("foo");
	});

	it("leaves valid slugs unchanged", () => {
		expect(sanitizeSlug("posts")).toBe("posts");
		expect(sanitizeSlug("my_type")).toBe("my_type");
	});

	it("handles mixed invalid characters", () => {
		expect(sanitizeSlug("my.custom" as string)).toBe("my_custom");
		expect(sanitizeSlug("type with spaces" as string)).toBe("type_with_spaces");
	});

	it("falls back to 'imported' when result would be empty", () => {
		expect(sanitizeSlug("123")).toBe("imported");
		expect(sanitizeSlug("---")).toBe("imported");
		expect(sanitizeSlug("_")).toBe("imported");
		expect(sanitizeSlug("")).toBe("imported");
	});

	it("preserves hyphens including leading hyphens after stripping", () => {
		expect(sanitizeSlug("-elementor-hf")).toBe("elementor-hf");
	});

	it("lowercases uppercase letters instead of dropping them", () => {
		expect(sanitizeSlug("MyCustomType")).toBe("mycustomtype");
		expect(sanitizeSlug("MyPortfolio")).toBe("myportfolio");
		expect(sanitizeSlug("ALLCAPS")).toBe("allcaps");
	});

	it("prefixes reserved collection slugs with wp_", () => {
		expect(sanitizeSlug("media")).toBe("wp_media");
		expect(sanitizeSlug("content")).toBe("wp_content");
		expect(sanitizeSlug("users")).toBe("wp_users");
		expect(sanitizeSlug("revisions")).toBe("wp_revisions");
		expect(sanitizeSlug("taxonomies")).toBe("wp_taxonomies");
		expect(sanitizeSlug("options")).toBe("wp_options");
		expect(sanitizeSlug("audit_logs")).toBe("wp_audit_logs");
	});
});

describe("mapPostTypeToCollection", () => {
	it("maps known WordPress post types", () => {
		expect(mapPostTypeToCollection("post")).toBe("posts");
		expect(mapPostTypeToCollection("page")).toBe("pages");
		expect(mapPostTypeToCollection("product")).toBe("products");
	});

	it("maps attachment to media (known mapping bypasses reserved check)", () => {
		expect(mapPostTypeToCollection("attachment")).toBe("media");
	});

	it("preserves hyphens in unknown post types (fixes #79)", () => {
		expect(mapPostTypeToCollection("elementor-hf")).toBe("elementor-hf");
		expect(mapPostTypeToCollection("my-custom-type")).toBe("my-custom-type");
	});

	it("preserves hyphens in post types from common plugins", () => {
		// WooCommerce
		expect(mapPostTypeToCollection("shop-order")).toBe("shop-order");
		// ACF
		expect(mapPostTypeToCollection("acf-field-group")).toBe("acf-field-group");
	});

	it("passes through valid unknown post types unchanged", () => {
		expect(mapPostTypeToCollection("recipes")).toBe("recipes");
		expect(mapPostTypeToCollection("portfolio")).toBe("portfolio");
	});

	it("prefixes reserved slugs that fall through to sanitize", () => {
		// "content" is not in the known mapping, so it hits sanitizeSlug
		expect(mapPostTypeToCollection("content")).toBe("wp_content");
		expect(mapPostTypeToCollection("users")).toBe("wp_users");
	});
});
