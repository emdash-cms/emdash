import { describe, it, expect } from "vitest";

import { isBlockedInPlayground } from "../../src/db/do-playground-routes.js";

describe("isBlockedInPlayground", () => {
	describe("blocked routes", () => {
		it.each([
			// Auth routes
			"/_emdash/api/auth/",
			"/_emdash/api/auth/passkey/options",
			"/_emdash/api/auth/passkey/verify",
			"/_emdash/api/auth/dev-bypass",
			"/_emdash/api/auth/magic-link/send",
			"/_emdash/api/auth/logout",
			// Setup routes
			"/_emdash/api/setup/",
			"/_emdash/api/setup/status",
			"/_emdash/api/setup/admin",
			"/_emdash/api/setup/dev-bypass",
			// OAuth routes
			"/_emdash/api/oauth/",
			"/_emdash/api/oauth/authorize",
			"/_emdash/api/oauth/token",
			// Token management
			"/_emdash/api/tokens/",
			"/_emdash/api/tokens/abc123",
			// User invite
			"/_emdash/api/users/invite",
			// Plugin install/marketplace
			"/_emdash/api/plugins/install",
			"/_emdash/api/plugins/marketplace",
			"/_emdash/api/plugins/marketplace/featured",
			// Media upload (abuse vector)
			"/_emdash/api/media/upload",
			// Snapshot export
			"/_emdash/api/snapshot",
			"/_emdash/api/snapshot?drafts=true",
		])("blocks %s", (path: string) => {
			expect(isBlockedInPlayground(path)).toBe(true);
		});
	});

	it.each([
		["POST", "/_emdash/api/media"],
		["POST", "/_emdash/api/import/wordpress/media"],
		["POST", "/_emdash/api/media/upload-url"],
		["PUT", "/_emdash/api/media/media-id/upload"],
		["POST", "/_emdash/api/media/media-id/confirm"],
		["DELETE", "/_emdash/api/media/media-id"],
		["POST", "/_emdash/api/media/providers/local"],
		["DELETE", "/_emdash/api/media/providers/local/media-id"],
		["DELETE", "/_emdash/api/media/media-id/"],
		["DELETE", "/_emdash/api/media/providers/local/media-id/"],
	])("blocks %s %s", (method, path) => {
		expect(isBlockedInPlayground(path, method)).toBe(true);
	});

	it.each([
		["GET", "/_emdash/api/media"],
		["GET", "/_emdash/api/media/media-id"],
		["PUT", "/_emdash/api/media/media-id"],
		["GET", "/_emdash/api/media/providers/local"],
		["GET", "/_emdash/api/media/providers/local/media-id"],
	])("allows %s %s", (method, path) => {
		expect(isBlockedInPlayground(path, method)).toBe(false);
	});

	it("normalizes slash-heavy paths without excessive backtracking", () => {
		const pathname = `${"/".repeat(64_000)}x`;
		const startedAt = performance.now();

		expect(isBlockedInPlayground(pathname)).toBe(false);
		expect(performance.now() - startedAt).toBeLessThan(250);
	});

	describe("allowed routes", () => {
		it.each([
			// Site pages
			"/",
			"/blog/my-post",
			"/about",
			"/sitemap.xml",
			// Admin UI
			"/_emdash/admin",
			"/_emdash/admin/content",
			"/_emdash/admin/content/posts",
			"/_emdash/admin/settings",
			"/_emdash/admin/media",
			"/_emdash/admin/schema",
			// Auth allowlist (admin UI needs /auth/me)
			"/_emdash/api/auth/me",
			// Content CRUD (the whole point of the playground)
			"/_emdash/api/content/posts",
			"/_emdash/api/content/posts/abc123",
			// Schema editing
			"/_emdash/api/schema",
			"/_emdash/api/schema/collections",
			"/_emdash/api/schema/collections/posts/fields",
			// Taxonomies
			"/_emdash/api/taxonomies",
			"/_emdash/api/taxonomies/category/terms",
			// Menus
			"/_emdash/api/menus",
			"/_emdash/api/menus/primary/items",
			// Widgets
			"/_emdash/api/widgets",
			// Search
			"/_emdash/api/search",
			"/_emdash/api/search/suggest",
			// Settings (read/write)
			"/_emdash/api/settings",
			// Dashboard
			"/_emdash/api/dashboard",
			// Manifest
			"/_emdash/api/manifest",
			// Media listing (not upload)
			"/_emdash/api/media",
			"/_emdash/api/media/abc123",
			"/_emdash/api/media/file/image.jpg",
			// Users list (not invite)
			"/_emdash/api/users",
			"/_emdash/api/users/abc123",
			// Plugin list (not install/marketplace)
			"/_emdash/api/plugins",
			"/_emdash/api/plugins/my-plugin",
		])("allows %s", (path: string) => {
			expect(isBlockedInPlayground(path)).toBe(false);
		});
	});
});
