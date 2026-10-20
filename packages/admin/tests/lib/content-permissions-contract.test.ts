import { describe, expect, it } from "vitest";

// Import source (not package `dist`) so the contract tracks edits without a prior `auth` build.
import { canActOnOwn, Permissions } from "../../../auth/src/rbac.js";
import { Role } from "../../../auth/src/types.js";
import {
	canActOnOwnContent,
	CONTENT_PERMISSION_MIN_ROLE,
	type ContentPermission,
} from "../../src/lib/content-permissions.js";

describe("content permission drift guard", () => {
	it("admin minimum roles match the server permission map", () => {
		for (const [permission, minRole] of Object.entries(CONTENT_PERMISSION_MIN_ROLE)) {
			expect({ permission, minRole }).toEqual({
				permission,
				minRole: Permissions[permission as ContentPermission],
			});
		}
	});

	it("ownership checks agree with the server for every role and owner", () => {
		const pairs: [ContentPermission, ContentPermission][] = [
			["content:edit_own", "content:edit_any"],
			["content:edit_own_drafts", "content:edit_any"],
			["content:publish_own", "content:publish_any"],
		];
		for (const role of Object.values(Role)) {
			const user = { id: "user_1", role };
			for (const [authorId, serverOwnerId] of [
				["user_1", "user_1"],
				["user_2", "user_2"],
				[null, ""],
			] as const) {
				for (const [own, any] of pairs) {
					expect({
						role,
						authorId,
						own,
						allowed: canActOnOwnContent(user, authorId, own, any),
					}).toEqual({
						role,
						authorId,
						own,
						allowed: canActOnOwn(user, serverOwnerId, own, any),
					});
				}
			}
		}
	});
});
