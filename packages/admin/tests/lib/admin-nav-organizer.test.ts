/**
 * Organizer draft tests — the edit-and-save contract.
 *
 * The key invariants: every op is pure (input draft untouched), the
 * serialized config is minimal (unchanged default groups omitted so their
 * labels keep translating), and a serialized draft rebuilds into a model
 * with exactly the layout the admin arranged (round-trip).
 */

import { describe, expect, it } from "vitest";

import {
	buildAdminNavModel,
	type AdminNavManifestInput,
	type AdminNavModel,
} from "../../src/lib/admin-nav";
import {
	addOrganizerGroup,
	buildItemDefaultGroups,
	createOrganizerDraft,
	deleteOrganizerGroup,
	generateGroupId,
	hideOrganizerItem,
	moveOrganizerGroup,
	moveOrganizerItem,
	moveOrganizerItemInGroup,
	organizerDraftsEqual,
	renameOrganizerGroup,
	serializeOrganizerDraft,
	setOrganizerGroupCollapsedByDefault,
	showOrganizerItem,
	type OrganizerDraft,
} from "../../src/lib/admin-nav-organizer";

const ROLE_ADMIN = 50;

function manifest(): AdminNavManifestInput {
	return {
		collections: { posts: { label: "Posts" }, pages: { label: "Pages" } },
		taxonomies: [{ name: "category", label: "Categories" }],
		plugins: {},
	};
}

function organizerModel(input: AdminNavManifestInput = manifest()): AdminNavModel {
	return buildAdminNavModel(input, { userRole: ROLE_ADMIN, includeEmptyGroups: true });
}

function freshDraft(): OrganizerDraft {
	return createOrganizerDraft(organizerModel());
}

function group(draft: OrganizerDraft, id: string) {
	return draft.groups.find((entry) => entry.id === id);
}

describe("createOrganizerDraft", () => {
	it("mirrors the model minus the dashboard block", () => {
		const draft = freshDraft();
		expect(draft.groups.map((entry) => entry.id)).toEqual([
			"content",
			"manage",
			"admin",
			"plugins",
		]);
		expect(group(draft, "content")?.itemIds).toEqual([
			"collection:posts",
			"collection:pages",
			"core:media",
		]);
		expect(group(draft, "plugins")?.itemIds).toEqual([]);
		expect(draft.hiddenIds).toEqual([]);
	});

	it("marks default groups and detects renames from config", () => {
		const model = buildAdminNavModel(
			{
				...manifest(),
				adminNavigation: {
					version: 1,
					groups: [
						{ id: "content", label: "Stuff", order: 100 },
						{ id: "editorial", label: "Editorial", order: 150 },
					],
					items: [{ id: "collection:posts", groupId: "editorial" }],
				},
			},
			{ userRole: ROLE_ADMIN, includeEmptyGroups: true },
		);
		const draft = createOrganizerDraft(model);
		expect(group(draft, "content")).toMatchObject({ isDefault: true, customLabel: "Stuff" });
		expect(group(draft, "manage")).toMatchObject({ isDefault: true, customLabel: undefined });
		expect(group(draft, "editorial")).toMatchObject({ isDefault: false, customLabel: "Editorial" });
	});
});

describe("organizer ops", () => {
	it("ops are pure — the input draft is never mutated", () => {
		const draft = freshDraft();
		const snapshot = JSON.stringify(draft);
		const defaults = buildItemDefaultGroups(organizerModel());

		addOrganizerGroup(draft, "Editorial");
		renameOrganizerGroup(draft, "content", "Stuff");
		moveOrganizerGroup(draft, "manage", -1);
		setOrganizerGroupCollapsedByDefault(draft, "manage", true);
		moveOrganizerItem(draft, "collection:posts", "manage");
		moveOrganizerItemInGroup(draft, "collection:pages", -1);
		hideOrganizerItem(draft, "core:media");
		deleteOrganizerGroup(addOrganizerGroup(draft, "Tmp"), "tmp", defaults);
		showOrganizerItem(hideOrganizerItem(draft, "core:media"), "core:media", defaults);

		expect(JSON.stringify(draft)).toBe(snapshot);
	});

	it("adds groups with generated ids and renames any group", () => {
		let draft = addOrganizerGroup(freshDraft(), "  Editorial Desk  ");
		expect(group(draft, "editorial-desk")).toMatchObject({
			isDefault: false,
			customLabel: "Editorial Desk",
			itemIds: [],
		});
		draft = renameOrganizerGroup(draft, "content", "Stuff");
		expect(group(draft, "content")?.customLabel).toBe("Stuff");
	});

	it("generateGroupId slugifies, avoids collisions and reserved ids", () => {
		expect(generateGroupId("Editorial Desk", [])).toBe("editorial-desk");
		expect(generateGroupId("Editorial", ["editorial"])).toBe("editorial-2");
		expect(generateGroupId("Dashboard", [])).toBe("dashboard-2");
		// Non-Latin names slugify to nothing → stable fallback.
		expect(generateGroupId("تحرير", [])).toBe("group");
		expect(generateGroupId("تحرير", ["group"])).toBe("group-2");
	});

	it("moves groups up and down with boundary no-ops", () => {
		let draft = moveOrganizerGroup(freshDraft(), "manage", -1);
		expect(draft.groups.map((entry) => entry.id)).toEqual([
			"manage",
			"content",
			"admin",
			"plugins",
		]);
		draft = moveOrganizerGroup(draft, "manage", -1);
		expect(draft.groups[0]?.id).toBe("manage");
	});

	it("moves items between groups and within a group", () => {
		let draft = moveOrganizerItem(freshDraft(), "collection:posts", "manage");
		expect(group(draft, "content")?.itemIds).toEqual(["collection:pages", "core:media"]);
		expect(group(draft, "manage")?.itemIds.at(-1)).toBe("collection:posts");

		draft = moveOrganizerItemInGroup(draft, "core:media", -1);
		expect(group(draft, "content")?.itemIds).toEqual(["core:media", "collection:pages"]);

		// Unknown target group → no-op.
		expect(moveOrganizerItem(draft, "core:media", "nope")).toBe(draft);
	});

	it("hides and shows items, unhide returns to the default group", () => {
		const defaults = buildItemDefaultGroups(organizerModel());
		let draft = moveOrganizerItem(freshDraft(), "taxonomy:category", "content");
		draft = hideOrganizerItem(draft, "taxonomy:category");
		expect(draft.hiddenIds).toEqual(["taxonomy:category"]);
		expect(group(draft, "content")?.itemIds).not.toContain("taxonomy:category");

		draft = showOrganizerItem(draft, "taxonomy:category", defaults);
		expect(draft.hiddenIds).toEqual([]);
		// Back to manage (its default), not content (its last position).
		expect(group(draft, "manage")?.itemIds.at(-1)).toBe("taxonomy:category");
	});

	it("deleting a custom group returns its items to their default groups", () => {
		const defaults = buildItemDefaultGroups(organizerModel());
		let draft = addOrganizerGroup(freshDraft(), "Editorial");
		draft = moveOrganizerItem(draft, "collection:posts", "editorial");
		draft = moveOrganizerItem(draft, "taxonomy:category", "editorial");
		draft = deleteOrganizerGroup(draft, "editorial", defaults);

		expect(draft.groups.some((entry) => entry.id === "editorial")).toBe(false);
		expect(group(draft, "content")?.itemIds.at(-1)).toBe("collection:posts");
		expect(group(draft, "manage")?.itemIds.at(-1)).toBe("taxonomy:category");

		// Default groups can't be deleted.
		expect(deleteOrganizerGroup(draft, "content", defaults)).toBe(draft);
	});
});

describe("serializeOrganizerDraft", () => {
	it("serializes a pristine draft with no group entries", () => {
		const config = serializeOrganizerDraft(freshDraft());
		expect(config.version).toBe(1);
		expect(config.groups).toEqual([]);
		// Items are pinned explicitly (group + order) even when unchanged.
		// (No marketplace in the fixture: admin = content-types, byline-schema,
		// users, plugins-manager, import-wordpress, settings, navigation.)
		expect(config.items).toContainEqual({ id: "collection:posts", groupId: "content", order: 0 });
		expect(config.items).toContainEqual({ id: "core:navigation", groupId: "admin", order: 6 });
	});

	it("writes moved defaults without labels and customs with labels", () => {
		let draft = addOrganizerGroup(freshDraft(), "Editorial");
		// editorial is appended last; move it between content and manage.
		draft = moveOrganizerGroup(draft, "editorial", -1);
		draft = moveOrganizerGroup(draft, "editorial", -1);
		draft = moveOrganizerGroup(draft, "editorial", -1);
		draft = setOrganizerGroupCollapsedByDefault(draft, "editorial", true);

		const config = serializeOrganizerDraft(draft);
		// content keeps slot 100 → omitted; the shifted defaults are written
		// order-only (no label → translations keep applying).
		expect(config.groups).toEqual([
			{ id: "editorial", order: 200, label: "Editorial", collapsedByDefault: true },
			{ id: "manage", order: 300 },
			{ id: "admin", order: 400 },
			{ id: "plugins", order: 500 },
		]);
	});

	it("serializes hidden items with only the hidden flag", () => {
		const draft = hideOrganizerItem(freshDraft(), "core:media");
		const config = serializeOrganizerDraft(draft);
		expect(config.items).toContainEqual({ id: "core:media", hidden: true });
		expect(config.items.filter((item) => item.id === "core:media")).toHaveLength(1);
	});

	it("round-trips: the rebuilt model matches the arranged layout", () => {
		const defaults = buildItemDefaultGroups(organizerModel());
		let draft = addOrganizerGroup(freshDraft(), "Editorial");
		draft = moveOrganizerItem(draft, "collection:posts", "editorial");
		draft = moveOrganizerItem(draft, "taxonomy:category", "editorial");
		draft = moveOrganizerItemInGroup(draft, "taxonomy:category", -1);
		draft = hideOrganizerItem(draft, "core:redirects");
		draft = renameOrganizerGroup(draft, "content", "Stuff");
		draft = moveOrganizerGroup(draft, "editorial", -1);
		draft = moveOrganizerGroup(draft, "editorial", -1);
		draft = moveOrganizerGroup(draft, "editorial", -1);
		void defaults;

		const config = serializeOrganizerDraft(draft);
		const rebuilt = buildAdminNavModel(
			{ ...manifest(), adminNavigation: config },
			{ userRole: ROLE_ADMIN, includeEmptyGroups: true },
		);

		const rebuiltDraft = createOrganizerDraft(rebuilt);
		expect(organizerDraftsEqual(draft, rebuiltDraft)).toBe(true);
		// Three up-moves from the end (index 4) put editorial at index 1.
		expect(rebuiltDraft.groups.map((entry) => entry.id)).toEqual([
			"content",
			"editorial",
			"manage",
			"admin",
			"plugins",
		]);
		expect(group(rebuiltDraft, "editorial")?.itemIds).toEqual([
			"taxonomy:category",
			"collection:posts",
		]);
		expect(group(rebuiltDraft, "content")?.customLabel).toBe("Stuff");
		expect(rebuiltDraft.hiddenIds).toEqual(["core:redirects"]);
	});

	it("dirty tracking: equal after no-op edits, different after real ones", () => {
		const draft = freshDraft();
		expect(organizerDraftsEqual(draft, moveOrganizerGroup(draft, "content", -1))).toBe(true);
		expect(organizerDraftsEqual(draft, hideOrganizerItem(draft, "core:media"))).toBe(false);
	});
});
