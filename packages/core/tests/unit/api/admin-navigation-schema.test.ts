/**
 * Admin navigation config schema + normalization tests.
 *
 * The normal form matters beyond validation: the normalized JSON feeds the
 * manifest hash, so semantically equal configs must serialize identically,
 * and lockout prevention (non-hideable items) is enforced here rather than
 * in every consumer.
 */

import { describe, expect, it } from "vitest";

import {
	normalizeAdminNavigationConfig,
	parseAdminNavigationItemId,
	type AdminNavigationConfigV1,
} from "../../../src/api/schemas/admin-navigation.js";

function validConfig(): AdminNavigationConfigV1 {
	return {
		version: 1,
		groups: [
			{ id: "editorial", label: "Editorial", order: 0 },
			{ id: "shop", label: "Shop", order: 1, collapsedByDefault: true },
		],
		items: [
			{ id: "collection:posts", groupId: "editorial", order: 0 },
			{ id: "taxonomy:category", groupId: "editorial", order: 1 },
			{ id: "collection:products", groupId: "shop", order: 0 },
			{ id: "core:redirects", hidden: true },
		],
	};
}

describe("parseAdminNavigationItemId", () => {
	it("parses each id kind", () => {
		expect(parseAdminNavigationItemId("core:content-types")).toEqual({
			kind: "core",
			key: "content-types",
		});
		expect(parseAdminNavigationItemId("collection:blog_posts")).toEqual({
			kind: "collection",
			slug: "blog_posts",
		});
		expect(parseAdminNavigationItemId("taxonomy:category")).toEqual({
			kind: "taxonomy",
			name: "category",
		});
		expect(parseAdminNavigationItemId("plugin:my-analytics:%2Fstats")).toEqual({
			kind: "plugin",
			pluginId: "my-analytics",
			pagePath: "%2Fstats",
		});
	});

	it("rejects malformed ids", () => {
		expect(parseAdminNavigationItemId("")).toBeUndefined();
		expect(parseAdminNavigationItemId("core:")).toBeUndefined();
		expect(parseAdminNavigationItemId("unknown:posts")).toBeUndefined();
		expect(parseAdminNavigationItemId("collection:Posts")).toBeUndefined();
		expect(parseAdminNavigationItemId("collection:9lives")).toBeUndefined();
		expect(parseAdminNavigationItemId("collection:posts:extra")).toBeUndefined();
		// taxonomy names follow slug rules: no dashes
		expect(parseAdminNavigationItemId("taxonomy:product-type")).toBeUndefined();
		// plugin ids need both segments; raw colons in the path split into a 4th segment
		expect(parseAdminNavigationItemId("plugin:analytics")).toBeUndefined();
		expect(parseAdminNavigationItemId("plugin:analytics:a:b")).toBeUndefined();
		expect(parseAdminNavigationItemId("plugin::path")).toBeUndefined();
		expect(parseAdminNavigationItemId(`collection:${"a".repeat(64)}`)).toBeUndefined();
		expect(parseAdminNavigationItemId(`core:${"a".repeat(300)}`)).toBeUndefined();
	});
});

describe("normalizeAdminNavigationConfig", () => {
	it("accepts and returns a valid config", () => {
		const normalized = normalizeAdminNavigationConfig(validConfig());
		expect(normalized).toBeDefined();
		expect(normalized?.groups.map((g) => g.id)).toEqual(["editorial", "shop"]);
		expect(normalized?.items.map((i) => i.id)).toEqual([
			"core:redirects",
			"collection:posts",
			"taxonomy:category",
			"collection:products",
		]);
	});

	it("rejects non-objects, wrong versions, and malformed fields", () => {
		expect(normalizeAdminNavigationConfig(null)).toBeUndefined();
		expect(normalizeAdminNavigationConfig("nope")).toBeUndefined();
		expect(normalizeAdminNavigationConfig({ version: 2, groups: [], items: [] })).toBeUndefined();
		expect(normalizeAdminNavigationConfig({ version: 1, groups: [], items: {} })).toBeUndefined();

		const badGroupId = validConfig();
		badGroupId.groups[0]!.id = "Editorial";
		expect(normalizeAdminNavigationConfig(badGroupId)).toBeUndefined();

		const emptyLabel = validConfig();
		emptyLabel.groups[0]!.label = "   ";
		expect(normalizeAdminNavigationConfig(emptyLabel)).toBeUndefined();

		const badOrder = validConfig();
		badOrder.groups[0]!.order = -1;
		expect(normalizeAdminNavigationConfig(badOrder)).toBeUndefined();

		const fractionalOrder = validConfig();
		fractionalOrder.items[0]!.order = 1.5;
		expect(normalizeAdminNavigationConfig(fractionalOrder)).toBeUndefined();

		const badItemId = validConfig();
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately invalid input
		badItemId.items[0]!.id = "collection:Not A Slug" as never;
		expect(normalizeAdminNavigationConfig(badItemId)).toBeUndefined();
	});

	it("dedupes duplicate group and item ids, first occurrence wins", () => {
		const config = {
			version: 1,
			groups: [
				{ id: "one", label: "First", order: 0 },
				{ id: "one", label: "Second", order: 5 },
			],
			items: [
				{ id: "collection:posts", groupId: "one", order: 0 },
				{ id: "collection:posts", hidden: true },
			],
		};
		const normalized = normalizeAdminNavigationConfig(config);
		expect(normalized?.groups).toEqual([{ id: "one", label: "First", order: 0 }]);
		expect(normalized?.items).toEqual([{ id: "collection:posts", groupId: "one", order: 0 }]);
	});

	it("strips hidden from non-hideable items and drops no-op entries", () => {
		const config = {
			version: 1,
			groups: [],
			items: [
				{ id: "core:settings", hidden: true },
				{ id: "core:dashboard", hidden: true },
				{ id: "core:navigation", hidden: true },
				{ id: "core:settings", groupId: "content", hidden: true },
				{ id: "collection:posts", hidden: false },
				{ id: "collection:pages" },
			],
		};
		const normalized = normalizeAdminNavigationConfig(config);
		// The first core:settings entry becomes a no-op once hidden is
		// stripped (dropped); its duplicate was already deduped away.
		// hidden: false and bare entries carry no information either.
		expect(normalized?.items).toEqual([]);
	});

	it("keeps placement on non-hideable items while stripping hidden", () => {
		const config = {
			version: 1,
			groups: [{ id: "custom", label: "Custom", order: 0 }],
			items: [{ id: "core:settings", groupId: "custom", hidden: true }],
		};
		const normalized = normalizeAdminNavigationConfig(config);
		expect(normalized?.items).toEqual([{ id: "core:settings", groupId: "custom" }]);
	});

	it("keeps the dashboard group pinned and reserved", () => {
		const config = {
			version: 1,
			groups: [{ id: "dashboard", label: "Moved", order: 500, collapsedByDefault: true }],
			items: [
				{ id: "core:dashboard", groupId: "content", order: 4 },
				{ id: "core:media", groupId: "dashboard", order: 2 },
			],
		};
		const normalized = normalizeAdminNavigationConfig(config);
		expect(normalized?.groups).toEqual([]);
		expect(normalized?.items).toEqual([{ id: "core:media", order: 2 }]);
	});

	it("trims group labels", () => {
		const config = validConfig();
		config.groups[0]!.label = "  Editorial  ";
		const normalized = normalizeAdminNavigationConfig(config);
		expect(normalized?.groups[0]?.label).toBe("Editorial");
	});

	it("accepts groups without a label (reordered defaults keep translated labels)", () => {
		const config = {
			version: 1,
			groups: [
				{ id: "manage", order: 0 },
				{ id: "content", order: 1 },
			],
			items: [],
		};
		const normalized = normalizeAdminNavigationConfig(config);
		expect(normalized?.groups).toEqual([
			{ id: "manage", order: 0 },
			{ id: "content", order: 1 },
		]);
	});

	it("is idempotent and order-insensitive (stable normal form)", () => {
		const once = normalizeAdminNavigationConfig(validConfig());
		expect(once).toBeDefined();
		const twice = normalizeAdminNavigationConfig(once);
		expect(twice).toEqual(once);

		const shuffled = validConfig();
		shuffled.groups.reverse();
		shuffled.items.reverse();
		expect(normalizeAdminNavigationConfig(shuffled)).toEqual(once);
		expect(JSON.stringify(normalizeAdminNavigationConfig(shuffled))).toBe(JSON.stringify(once));
	});

	it("preserves stale ids that still parse (unknown collections/plugins)", () => {
		const config = {
			version: 1,
			groups: [{ id: "legacy", label: "Legacy", order: 0 }],
			items: [
				{ id: "collection:deleted_collection", groupId: "legacy" },
				{ id: "plugin:removed-plugin:%2Fpage", hidden: true },
			],
		};
		const normalized = normalizeAdminNavigationConfig(config);
		// Ungrouped items (empty groupId key) sort before grouped ones.
		expect(normalized?.items.map((i) => i.id)).toEqual([
			"plugin:removed-plugin:%2Fpage",
			"collection:deleted_collection",
		]);
	});
});
