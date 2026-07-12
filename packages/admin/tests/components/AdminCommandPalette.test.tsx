/**
 * Command palette nav entries — parity with the sidebar's nav model.
 *
 * The palette builds from the same `buildAdminNavModel` source as the
 * sidebar, so custom taxonomies and site nav config flow through instead
 * of the old hard-coded category/tag list. Pure-function tests (no DOM):
 * Kumo's CommandPalette portals to document.body, making mount-based
 * assertions brittle.
 */

import { describe, expect, it } from "vitest";

import { buildNavItems } from "../../src/components/AdminCommandPalette";
import type { AdminNavManifestInput } from "../../src/lib/admin-nav";

const ROLE_EDITOR = 40;
const ROLE_ADMIN = 50;

function manifest(): AdminNavManifestInput {
	return {
		collections: { posts: { label: "Posts" } },
		taxonomies: [
			{ name: "category", label: "Categories" },
			{ name: "genre", label: "Genres" },
		],
		plugins: {},
		adminNavigation: {
			version: 1,
			groups: [],
			items: [{ id: "core:widgets", hidden: true }],
		},
	};
}

describe("buildNavItems", () => {
	it("includes every manifest taxonomy, not a hard-coded list", () => {
		const ids = buildNavItems(manifest(), ROLE_EDITOR, {}).map((item) => item.id);
		expect(ids).toContain("taxonomy:category");
		expect(ids).toContain("taxonomy:genre");
	});

	it("keeps items hidden from the sidebar searchable (recovery path)", () => {
		const ids = buildNavItems(manifest(), ROLE_EDITOR, {}).map((item) => item.id);
		expect(ids).toContain("core:widgets");
	});

	it("applies role gating", () => {
		const editorIds = buildNavItems(manifest(), ROLE_EDITOR, {}).map((item) => item.id);
		expect(editorIds).not.toContain("core:users");
		expect(editorIds).not.toContain("core:settings-security");

		const adminIds = buildNavItems(manifest(), ROLE_ADMIN, {}).map((item) => item.id);
		expect(adminIds).toContain("core:users");
	});

	it("preserves the palette-only security settings deep link for admins", () => {
		const admin = buildNavItems(manifest(), ROLE_ADMIN, {});
		const security = admin.find((item) => item.id === "core:settings-security");
		expect(security?.to).toBe("/settings/security");
	});

	it("keeps keywords for search matching", () => {
		const items = buildNavItems(manifest(), ROLE_ADMIN, {});
		const media = items.find((item) => item.id === "core:media");
		// "library" preserves findability for users typing the old
		// "Media Library" palette label.
		expect(media?.keywords).toContain("library");
	});
});
