/**
 * Tests for WordPress import slug sanitization
 *
 * Regression test for emdash-cms/emdash#79: WordPress import crashes on
 * collections with hyphens in slug (e.g. Elementor `elementor-hf`).
 *
 * WordPress post type slugs commonly use hyphens (e.g. `elementor-hf`,
 * `my-custom-type`), but EmDash collection slugs require `[a-z][a-z0-9_]*`.
 * The fix sanitizes all unknown post type slugs so they conform to the
 * collection slug format, rather than trying to enumerate every plugin's
 * internal post types.
 */

import { describe, expect, it } from "vitest";

import {
	mapPostTypeToCollection,
	sanitizeSlug,
} from "../../../src/astro/routes/api/import/wordpress/analyze.js";

describe("sanitizeSlug", () => {
	it("replaces hyphens with underscores", () => {
		expect(sanitizeSlug("elementor-hf")).toBe("elementor_hf");
	});

	it("replaces multiple hyphens", () => {
		expect(sanitizeSlug("my-custom-type")).toBe("my_custom_type");
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

	it("multiple degenerate slugs produce the same fallback (deduplicated during analysis)", () => {
		// These all collapse to "imported" — analyzeWxr appends _1, _2, etc.
		expect(sanitizeSlug("123")).toBe("imported");
		expect(sanitizeSlug("456")).toBe("imported");
		expect(sanitizeSlug("---")).toBe("imported");
	});

	it("handles leading hyphens in realistic WP slugs", () => {
		expect(sanitizeSlug("-elementor-hf")).toBe("elementor_hf");
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

	it("sanitizes unknown post types with hyphens (fixes #79)", () => {
		expect(mapPostTypeToCollection("elementor-hf")).toBe("elementor_hf");
		expect(mapPostTypeToCollection("my-custom-type")).toBe("my_custom_type");
	});

	it("sanitizes post types from other common plugins", () => {
		// WooCommerce
		expect(mapPostTypeToCollection("shop-order")).toBe("shop_order");
		// ACF
		expect(mapPostTypeToCollection("acf-field-group")).toBe("acf_field_group");
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
