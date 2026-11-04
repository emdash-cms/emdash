/**
 * The content permissions the admin needs to decide which entry actions to
 * offer. Mirrors `Permissions` and `canActOnOwn` in `@emdash-cms/auth` and
 * `entryEditAccess` in core. `tests/lib/content-permissions-contract.test.ts`
 * fails when the minimum roles or the ownership rule drift apart.
 */

export const CONTENT_PERMISSION_MIN_ROLE = {
	"content:create": 20,
	"content:edit_own_drafts": 20,
	"content:edit_own": 30,
	"content:edit_any": 40,
	"content:publish_own": 30,
	"content:publish_any": 40,
} as const;

export type ContentPermission = keyof typeof CONTENT_PERMISSION_MIN_ROLE;

export interface PermissionUser {
	id: string;
	role: number;
}

export interface OwnedEntry {
	authorId: string | null;
	status: string;
}

export function hasContentPermission(
	user: PermissionUser | null | undefined,
	permission: ContentPermission,
): boolean {
	return !!user && user.role >= CONTENT_PERMISSION_MIN_ROLE[permission];
}

/**
 * An entry without a recorded author has no owner, so only the `any`
 * permission covers it.
 */
export function canActOnOwnContent(
	user: PermissionUser | null | undefined,
	authorId: string | null,
	ownPermission: ContentPermission,
	anyPermission: ContentPermission,
): boolean {
	if (!user) return false;
	if (authorId && user.id === authorId) return hasContentPermission(user, ownPermission);
	return hasContentPermission(user, anyPermission);
}

/**
 * `"full"` when the user can save the entry in any state, `"draft"` when they
 * can save it only while it is a draft, `null` when they can't save it.
 */
export function entryEditAccess(
	user: PermissionUser | null | undefined,
	entry: OwnedEntry,
): "full" | "draft" | null {
	if (canActOnOwnContent(user, entry.authorId, "content:edit_own", "content:edit_any")) {
		return "full";
	}
	if (
		entry.status === "draft" &&
		canActOnOwnContent(user, entry.authorId, "content:edit_own_drafts", "content:edit_any")
	) {
		return "draft";
	}
	return null;
}

/** Covers publish, unpublish, schedule and unschedule. */
export function canPublishEntry(
	user: PermissionUser | null | undefined,
	entry: Pick<OwnedEntry, "authorId">,
): boolean {
	return canActOnOwnContent(user, entry.authorId, "content:publish_own", "content:publish_any");
}

export function canDuplicateEntry(
	user: PermissionUser | null | undefined,
	entry: Pick<OwnedEntry, "authorId">,
): boolean {
	return (
		hasContentPermission(user, "content:create") &&
		canActOnOwnContent(user, entry.authorId, "content:edit_own", "content:edit_any")
	);
}
