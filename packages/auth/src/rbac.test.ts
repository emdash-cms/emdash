import { describe, it, expect } from "vitest";

import {
	hasPermission,
	requirePermission,
	canActOnOwn,
	requirePermissionOnResource,
	PermissionError,
} from "./rbac.js";
import { Role } from "./types.js";

describe("rbac", () => {
	describe("hasPermission", () => {
		it("returns false for null user", () => {
			expect(hasPermission(null, "content:read")).toBe(false);
		});

		it("returns false for undefined user", () => {
			expect(hasPermission(undefined, "content:read")).toBe(false);
		});

		it("allows subscriber to read content", () => {
			expect(hasPermission({ role: Role.SUBSCRIBER }, "content:read")).toBe(true);
		});

		it("denies subscriber from creating content", () => {
			expect(hasPermission({ role: Role.SUBSCRIBER }, "content:create")).toBe(false);
		});

		it("allows contributor to create content", () => {
			expect(hasPermission({ role: Role.CONTRIBUTOR }, "content:create")).toBe(true);
		});

		it("allows admin to do anything", () => {
			const admin = { role: Role.ADMIN };
			expect(hasPermission(admin, "content:read")).toBe(true);
			expect(hasPermission(admin, "content:create")).toBe(true);
			expect(hasPermission(admin, "users:manage")).toBe(true);
			expect(hasPermission(admin, "schema:manage")).toBe(true);
		});

		it("denies editor from managing users", () => {
			expect(hasPermission({ role: Role.EDITOR }, "users:manage")).toBe(false);
		});

		it("allows author to edit own media", () => {
			expect(hasPermission({ role: Role.AUTHOR }, "media:edit_own")).toBe(true);
		});

		it("denies contributor from editing media", () => {
			expect(hasPermission({ role: Role.CONTRIBUTOR }, "media:edit_own")).toBe(false);
		});

		it("allows editor to edit any media", () => {
			expect(hasPermission({ role: Role.EDITOR }, "media:edit_any")).toBe(true);
		});

		it("denies author from editing any media", () => {
			expect(hasPermission({ role: Role.AUTHOR }, "media:edit_any")).toBe(false);
		});

		// content:read_drafts gates non-published content reads and editor-only
		// views (revisions, compare, trash, preview-url).
		it("denies subscriber from reading drafts", () => {
			expect(hasPermission({ role: Role.SUBSCRIBER }, "content:read_drafts")).toBe(false);
		});

		it("allows contributor to read drafts", () => {
			expect(hasPermission({ role: Role.CONTRIBUTOR }, "content:read_drafts")).toBe(true);
		});

		it("allows editor to read drafts", () => {
			expect(hasPermission({ role: Role.EDITOR }, "content:read_drafts")).toBe(true);
		});
	});

	describe("requirePermission", () => {
		it("throws for null user", () => {
			expect(() => requirePermission(null, "content:read")).toThrow(PermissionError);
		});

		it("throws unauthorized for missing user", () => {
			try {
				requirePermission(null, "content:read");
			} catch (e) {
				expect(e).toBeInstanceOf(PermissionError);
				expect((e as PermissionError).code).toBe("unauthorized");
			}
		});

		it("throws forbidden for insufficient permissions", () => {
			try {
				requirePermission({ role: Role.SUBSCRIBER }, "content:create");
			} catch (e) {
				expect(e).toBeInstanceOf(PermissionError);
				expect((e as PermissionError).code).toBe("forbidden");
			}
		});

		it("does not throw for sufficient permissions", () => {
			expect(() => requirePermission({ role: Role.ADMIN }, "content:create")).not.toThrow();
		});
	});

	describe("canActOnOwn", () => {
		const user = { role: Role.AUTHOR, id: "user-1" };

		it("allows action on own resource with own permission", () => {
			expect(canActOnOwn(user, "user-1", "content:edit_own", "content:edit_any")).toBe(true);
		});

		it("denies action on others resource without any permission", () => {
			expect(canActOnOwn(user, "user-2", "content:edit_own", "content:edit_any")).toBe(false);
		});

		it("allows editor to edit any resource", () => {
			const editor = { role: Role.EDITOR, id: "editor-1" };
			expect(canActOnOwn(editor, "user-2", "content:edit_own", "content:edit_any")).toBe(true);
		});

		it("allows author to edit own media", () => {
			expect(canActOnOwn(user, "user-1", "media:edit_own", "media:edit_any")).toBe(true);
		});

		it("denies author from editing others media", () => {
			expect(canActOnOwn(user, "user-2", "media:edit_own", "media:edit_any")).toBe(false);
		});

		it("denies contributor from editing any media (including own)", () => {
			const contributor = { role: Role.CONTRIBUTOR, id: "contrib-1" };
			expect(canActOnOwn(contributor, "contrib-1", "media:edit_own", "media:edit_any")).toBe(false);
		});

		it("allows editor to edit any media", () => {
			const editor = { role: Role.EDITOR, id: "editor-1" };
			expect(canActOnOwn(editor, "user-2", "media:edit_own", "media:edit_any")).toBe(true);
		});

		it("F17: empty-string ownerId is not treated as 'owned by user with id ''", () => {
			// A user with id="" and *:edit_own (but NOT *:edit_any) must NOT
			// be able to edit content with ownerId="" — that ownerId means
			// "no recorded owner" (e.g. seed-imported content), and granting
			// edit-own would be an accidental privilege escalation.
			const orphanedUser = { role: Role.AUTHOR, id: "" };
			expect(canActOnOwn(orphanedUser, "", "content:edit_own", "content:edit_any")).toBe(false);
		});
	});

	describe("requirePermissionOnResource", () => {
		it("allows author to edit own content", () => {
			const user = { role: Role.AUTHOR, id: "user-1" };
			expect(() =>
				requirePermissionOnResource(user, "user-1", "content:edit_own", "content:edit_any"),
			).not.toThrow();
		});

		it("throws for author editing others content", () => {
			const user = { role: Role.AUTHOR, id: "user-1" };
			expect(() =>
				requirePermissionOnResource(user, "user-2", "content:edit_own", "content:edit_any"),
			).toThrow(PermissionError);
		});
	});
});
