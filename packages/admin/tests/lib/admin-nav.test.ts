/**
 * Nav model tests — the parity contract.
 *
 * With no site config, `buildAdminNavModel` must reproduce the classic
 * hardcoded sidebar exactly (same groups, order, role gating), plus the
 * one new Navigation organizer entry under Admin. The config-application
 * tests pin grouping/ordering/hiding semantics: stale config never loses
 * items, non-hideable items can't be hidden, role gating always wins.
 */

import { describe, expect, it } from "vitest";

import {
	buildAdminNavModel,
	flattenAdminNavModel,
	isGroupCollapsed,
	parseNavCollapseState,
	serializeNavCollapseState,
	toggleGroupCollapsed,
	type AdminNavManifestInput,
	type AdminNavModel,
} from "../../src/lib/admin-nav";

const ROLE_AUTHOR = 30;
const ROLE_EDITOR = 40;
const ROLE_ADMIN = 50;

function baseManifest(): AdminNavManifestInput {
	return {
		collections: {
			posts: { label: "Posts" },
			products: { label: "Products", icon: "storefront" },
		},
		taxonomies: [
			{ name: "category", label: "Categories" },
			{ name: "tag", label: "Tags" },
		],
		plugins: {
			analytics: {
				enabled: true,
				adminMode: "blocks",
				adminPages: [{ path: "/stats", label: "Analytics", icon: "chart" }],
			},
			ghostwriter: {
				enabled: false,
				adminMode: "blocks",
				adminPages: [{ path: "/write", label: "Ghostwriter" }],
			},
			reactive: {
				enabled: true,
				adminMode: "react",
				adminPages: [{ path: "/panel", label: "Panel" }],
			},
		},
		marketplace: "https://marketplace.example",
	};
}

function groupIds(model: AdminNavModel): string[] {
	return model.groups.map((group) => group.id);
}

function itemIds(model: AdminNavModel, groupId: string): string[] {
	return model.groups.find((group) => group.id === groupId)?.items.map((item) => item.id) ?? [];
}

describe("buildAdminNavModel defaults (parity with the classic sidebar)", () => {
	it("reproduces the classic groups and order for an admin", () => {
		const model = buildAdminNavModel(baseManifest(), { userRole: ROLE_ADMIN });

		expect(groupIds(model)).toEqual(["dashboard", "content", "manage", "admin", "plugins"]);
		expect(itemIds(model, "dashboard")).toEqual(["core:dashboard"]);
		expect(itemIds(model, "content")).toEqual([
			"collection:posts",
			"collection:products",
			"core:media",
		]);
		expect(itemIds(model, "manage")).toEqual([
			"core:comments",
			"core:menus",
			"core:redirects",
			"core:widgets",
			"core:sections",
			"taxonomy:category",
			"taxonomy:tag",
			"core:bylines",
		]);
		expect(itemIds(model, "admin")).toEqual([
			"core:content-types",
			"core:byline-schema",
			"core:users",
			"core:plugins-manager",
			"core:marketplace",
			"core:themes",
			"core:import-wordpress",
			"core:settings",
			"core:navigation",
		]);
		// blocks-mode plugin passes without loaded modules; react-mode is
		// filtered until its page component resolves; disabled is dropped.
		expect(itemIds(model, "plugins")).toEqual(["plugin:analytics:%2Fstats"]);
		expect(model.hiddenItems).toEqual([]);
	});

	it("keeps the dashboard block header-less and non-collapsible", () => {
		const model = buildAdminNavModel(baseManifest(), { userRole: ROLE_ADMIN });
		const dashboard = model.groups[0];
		expect(dashboard?.label).toBeUndefined();
		expect(dashboard?.collapsible).toBe(false);
	});

	it("routes items to the classic paths with params", () => {
		const model = buildAdminNavModel(baseManifest(), { userRole: ROLE_ADMIN });
		const flat = flattenAdminNavModel(model);
		const byId = new Map(flat.map((item) => [item.id, item]));

		expect(byId.get("collection:posts")?.to).toBe("/content/$collection");
		expect(byId.get("collection:posts")?.params).toEqual({ collection: "posts" });
		expect(byId.get("taxonomy:tag")?.to).toBe("/taxonomies/$taxonomy");
		expect(byId.get("taxonomy:tag")?.params).toEqual({ taxonomy: "tag" });
		expect(byId.get("core:byline-schema")?.to).toBe("/byline-schema");
		expect(byId.get("plugin:analytics:%2Fstats")?.to).toBe("/plugins/analytics/stats");
		expect(byId.get("core:navigation")?.to).toBe("/settings/navigation");
	});

	it("includes react-mode plugin pages once their component resolves", () => {
		const model = buildAdminNavModel(baseManifest(), {
			userRole: ROLE_ADMIN,
			pluginAdmins: { reactive: { pages: { "/panel": () => null } } },
		});
		expect(itemIds(model, "plugins")).toEqual([
			"plugin:analytics:%2Fstats",
			"plugin:reactive:%2Fpanel",
		]);
	});

	it("applies the pending-comments badge", () => {
		const model = buildAdminNavModel(baseManifest(), { userRole: ROLE_EDITOR, pendingComments: 7 });
		const comments = flattenAdminNavModel(model).find((item) => item.id === "core:comments");
		expect(comments?.badge).toBe(7);
	});

	it("shows Registry instead of Marketplace when a registry is configured", () => {
		const withRegistry = buildAdminNavModel(
			{ ...baseManifest(), registry: { aggregatorUrl: "https://agg" } },
			{ userRole: ROLE_ADMIN },
		);
		const admin = itemIds(withRegistry, "admin");
		expect(admin).toContain("core:marketplace");
		expect(admin).toContain("core:themes");

		const without = buildAdminNavModel(
			{ ...baseManifest(), marketplace: undefined },
			{ userRole: ROLE_ADMIN },
		);
		expect(itemIds(without, "admin")).not.toContain("core:marketplace");
		expect(itemIds(without, "admin")).not.toContain("core:themes");
	});
});

describe("buildAdminNavModel role gating", () => {
	it("drops admin-only entries and the empty admin group for editors", () => {
		const model = buildAdminNavModel(baseManifest(), { userRole: ROLE_EDITOR });
		expect(groupIds(model)).toEqual(["dashboard", "content", "manage", "plugins"]);
		expect(itemIds(model, "manage")).not.toContain("core:redirects");
		expect(itemIds(model, "manage")).toContain("taxonomy:category");
	});

	it("leaves only ungated groups for authors and below", () => {
		for (const role of [ROLE_AUTHOR, 0]) {
			const model = buildAdminNavModel(baseManifest(), { userRole: role });
			expect(groupIds(model)).toEqual(["dashboard", "content", "plugins"]);
		}
	});

	it("gates byline-schema on admin (Discussion #1174 AC)", () => {
		const editor = buildAdminNavModel(baseManifest(), { userRole: ROLE_EDITOR });
		expect(flattenAdminNavModel(editor).map((i) => i.id)).not.toContain("core:byline-schema");
		const admin = buildAdminNavModel(baseManifest(), { userRole: ROLE_ADMIN });
		expect(flattenAdminNavModel(admin).map((i) => i.id)).toContain("core:byline-schema");
	});

	it("role gating wins over config placement", () => {
		const manifest: AdminNavManifestInput = {
			...baseManifest(),
			adminNavigation: {
				version: 1,
				groups: [{ id: "everyone", label: "Everyone", order: 50 }],
				items: [{ id: "core:users", groupId: "everyone", order: 0 }],
			},
		};
		const model = buildAdminNavModel(manifest, { userRole: ROLE_EDITOR });
		expect(groupIds(model)).not.toContain("everyone");
		expect(flattenAdminNavModel(model).map((i) => i.id)).not.toContain("core:users");
	});
});

describe("buildAdminNavModel config application", () => {
	function configuredManifest(): AdminNavManifestInput {
		return {
			...baseManifest(),
			adminNavigation: {
				version: 1,
				groups: [{ id: "editorial", label: "Editorial", order: 150, collapsedByDefault: true }],
				items: [
					{ id: "taxonomy:category", groupId: "editorial", order: 1 },
					{ id: "collection:posts", groupId: "editorial", order: 0 },
					{ id: "core:redirects", hidden: true },
					{ id: "collection:ghost", groupId: "editorial" },
					{ id: "core:settings", hidden: true },
					{ id: "collection:products", groupId: "deleted_group" },
				],
			},
		};
	}

	it("places custom groups by order between the defaults", () => {
		const model = buildAdminNavModel(configuredManifest(), { userRole: ROLE_ADMIN });
		// editorial (150) sits between content (100) and manage (200)
		expect(groupIds(model)).toEqual([
			"dashboard",
			"content",
			"editorial",
			"manage",
			"admin",
			"plugins",
		]);
		expect(itemIds(model, "editorial")).toEqual(["collection:posts", "taxonomy:category"]);
	});

	it("moves items out of their default groups without leaving ghosts", () => {
		const model = buildAdminNavModel(configuredManifest(), { userRole: ROLE_ADMIN });
		expect(itemIds(model, "content")).not.toContain("collection:posts");
		expect(itemIds(model, "manage")).not.toContain("taxonomy:category");
	});

	it("hides hideable items into hiddenItems, keeps non-hideable visible", () => {
		const model = buildAdminNavModel(configuredManifest(), { userRole: ROLE_ADMIN });
		expect(model.hiddenItems.map((i) => i.id)).toEqual(["core:redirects"]);
		expect(itemIds(model, "manage")).not.toContain("core:redirects");
		// core:settings is lockout-protected — hidden flag is ignored.
		expect(itemIds(model, "admin")).toContain("core:settings");
	});

	it("ignores stale item ids and falls back for stale group refs", () => {
		const model = buildAdminNavModel(configuredManifest(), { userRole: ROLE_ADMIN });
		const flat = flattenAdminNavModel(model).map((i) => i.id);
		expect(flat).not.toContain("collection:ghost");
		// products pointed at a deleted group → stays in its default group.
		expect(itemIds(model, "content")).toContain("collection:products");
	});

	it("lets config rename and reorder a default group", () => {
		const manifest: AdminNavManifestInput = {
			...baseManifest(),
			adminNavigation: {
				version: 1,
				groups: [{ id: "content", label: "Stuff", order: 350 }],
				items: [],
			},
		};
		const model = buildAdminNavModel(manifest, { userRole: ROLE_ADMIN });
		expect(groupIds(model)).toEqual(["dashboard", "manage", "admin", "content", "plugins"]);
		const content = model.groups.find((group) => group.id === "content");
		expect(content?.label).toBe("Stuff");
	});

	it("sorts configured items before unconfigured ones within a group", () => {
		const manifest: AdminNavManifestInput = {
			...baseManifest(),
			adminNavigation: {
				version: 1,
				groups: [],
				items: [{ id: "core:media", groupId: "content", order: 0 }],
			},
		};
		const model = buildAdminNavModel(manifest, { userRole: ROLE_ADMIN });
		expect(itemIds(model, "content")).toEqual([
			"core:media",
			"collection:posts",
			"collection:products",
		]);
	});

	it("passes collapsedByDefault through to the group", () => {
		const model = buildAdminNavModel(configuredManifest(), { userRole: ROLE_ADMIN });
		const editorial = model.groups.find((group) => group.id === "editorial");
		expect(editorial?.collapsedByDefault).toBe(true);
		expect(editorial?.collapsible).toBe(true);
	});

	it("drops custom groups that end up empty", () => {
		const manifest: AdminNavManifestInput = {
			...baseManifest(),
			adminNavigation: {
				version: 1,
				groups: [{ id: "empty_group", label: "Empty", order: 150 }],
				items: [],
			},
		};
		const model = buildAdminNavModel(manifest, { userRole: ROLE_ADMIN });
		expect(groupIds(model)).not.toContain("empty_group");
	});
});

describe("flattenAdminNavModel", () => {
	it("includes hidden items by default and excludes them on request", () => {
		const manifest: AdminNavManifestInput = {
			...baseManifest(),
			adminNavigation: {
				version: 1,
				groups: [],
				items: [{ id: "core:widgets", hidden: true }],
			},
		};
		const model = buildAdminNavModel(manifest, { userRole: ROLE_ADMIN });

		expect(flattenAdminNavModel(model).map((i) => i.id)).toContain("core:widgets");
		expect(flattenAdminNavModel(model, { includeHidden: false }).map((i) => i.id)).not.toContain(
			"core:widgets",
		);
	});
});

describe("nav collapse state", () => {
	const group = (overrides: { id: string; collapsedByDefault?: boolean }) => ({
		id: overrides.id,
		collapsible: true,
		collapsedByDefault: overrides.collapsedByDefault ?? false,
		items: [],
	});

	it("parses stored state and tolerates malformed data", () => {
		expect(parseNavCollapseState(null)).toEqual({ collapsedGroupIds: [], expandedGroupIds: [] });
		expect(parseNavCollapseState("{oops")).toEqual({ collapsedGroupIds: [], expandedGroupIds: [] });
		expect(parseNavCollapseState('{"collapsedGroupIds": "content"}')).toEqual({
			collapsedGroupIds: [],
			expandedGroupIds: [],
		});
		expect(parseNavCollapseState('{"collapsedGroupIds": ["manage"]}')).toEqual({
			collapsedGroupIds: ["manage"],
			expandedGroupIds: [],
		});
	});

	it("round-trips through serialize/parse", () => {
		const state = { collapsedGroupIds: ["manage"], expandedGroupIds: ["editorial"] };
		expect(parseNavCollapseState(serializeNavCollapseState(state))).toEqual(state);
	});

	it("resolves collapsed: explicit user choice beats collapsedByDefault", () => {
		const state = { collapsedGroupIds: ["a"], expandedGroupIds: ["b"] };
		expect(isGroupCollapsed(group({ id: "a" }), state)).toBe(true);
		expect(isGroupCollapsed(group({ id: "b", collapsedByDefault: true }), state)).toBe(false);
		expect(isGroupCollapsed(group({ id: "c", collapsedByDefault: true }), state)).toBe(true);
		expect(isGroupCollapsed(group({ id: "d" }), state)).toBe(false);
	});

	it("toggle moves a group between the two lists", () => {
		let state = { collapsedGroupIds: [], expandedGroupIds: [] } as ReturnType<
			typeof parseNavCollapseState
		>;
		state = toggleGroupCollapsed(state, "manage", true);
		expect(state).toEqual({ collapsedGroupIds: ["manage"], expandedGroupIds: [] });
		state = toggleGroupCollapsed(state, "manage", false);
		expect(state).toEqual({ collapsedGroupIds: [], expandedGroupIds: ["manage"] });
	});
});
