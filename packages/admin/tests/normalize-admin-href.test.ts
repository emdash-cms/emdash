import { describe, it, expect } from "vitest";

import { normalizeAdminHref } from "../src/App";

describe("normalizeAdminHref", () => {
	it("strips admin basepath for admin SPA routes", () => {
		expect(normalizeAdminHref("/_emdash/admin")).toBe("/");
		expect(normalizeAdminHref("/_emdash/admin/settings")).toBe("/settings");
		expect(normalizeAdminHref("/_emdash/admin/content/posts")).toBe("/content/posts");
	});

	it("handles admin basepath with query string", () => {
		expect(normalizeAdminHref("/_emdash/admin?tab=settings")).toBe("/?tab=settings");
	});

	it("handles admin basepath with hash", () => {
		expect(normalizeAdminHref("/_emdash/admin#section")).toBe("/#section");
	});

	it("returns empty string for non-admin /_emdash/ paths (forces anchor rendering)", () => {
		expect(normalizeAdminHref("/_emdash/api/auth/oauth/google")).toBe("");
		expect(normalizeAdminHref("/_emdash/api/auth/oauth/github")).toBe("");
		expect(normalizeAdminHref("/_emdash/api/auth/mode")).toBe("");
		expect(normalizeAdminHref("/_emdash/api/auth/passkey/options")).toBe("");
	});

	it("preserves admin-relative paths for TanStack Router", () => {
		// These paths do NOT start with /_emdash/ and should be passed through
		// unchanged so TanStack Router prepends the admin basepath.
		expect(normalizeAdminHref("/media")).toBe("/media");
		expect(normalizeAdminHref("/settings")).toBe("/settings");
		expect(normalizeAdminHref("/content/posts")).toBe("/content/posts");
		expect(normalizeAdminHref("/content/$collection")).toBe("/content/$collection");
	});

	it("preserves external URLs", () => {
		expect(normalizeAdminHref("https://example.com")).toBe("https://example.com");
	});

	it("preserves protocol-relative URLs", () => {
		expect(normalizeAdminHref("//example.com")).toBe("//example.com");
	});

	it("preserves mailto links", () => {
		expect(normalizeAdminHref("mailto:test@example.com")).toBe("mailto:test@example.com");
	});
});
