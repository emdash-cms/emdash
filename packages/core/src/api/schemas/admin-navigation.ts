/**
 * Admin navigation (sidebar IA) configuration.
 *
 * Site-wide sidebar organization — custom groups, ordering, hiding — stored
 * as one versioned JSON document in the `options` table under
 * {@link ADMIN_NAVIGATION_OPTION_KEY}, delivered to the admin SPA via the
 * manifest, and written through `PUT /_emdash/api/admin/navigation`.
 *
 * Grouping is presentation only: it never affects routing, authorization,
 * or the underlying schema tables. Item ids reference sidebar entries by
 * kind (`core:`, `collection:`, `taxonomy:`, `plugin:`); ids that reference
 * entries that no longer exist are kept in storage and ignored at render.
 */

import { z } from "zod";

/** `options` table key holding the sidebar navigation config. */
export const ADMIN_NAVIGATION_OPTION_KEY = "admin:navigation";

/**
 * Sidebar items that must stay reachable (lockout prevention). A stored
 * `hidden: true` on these ids is stripped during normalization.
 */
export const NON_HIDEABLE_NAV_ITEM_IDS: ReadonlySet<string> = new Set([
	"core:dashboard",
	"core:settings",
	"core:navigation",
]);

const GROUP_ID_PATTERN = /^[a-z][a-z0-9_-]{0,62}$/;
const CORE_KEY_PATTERN = /^[a-z][a-z0-9-]*$/;
/** Collection slugs and taxonomy names follow the schema-registry slug rules. */
const SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;
const PLUGIN_ID_PATTERN = /^[a-z0-9@][a-z0-9@/_.-]*$/i;

const ITEM_ID_MAX_LENGTH = 256;
const SLUG_MAX_LENGTH = 63;

export type AdminNavigationItemId =
	| `core:${string}`
	| `collection:${string}`
	| `taxonomy:${string}`
	| `plugin:${string}:${string}`;

export type ParsedAdminNavigationItemId =
	| { kind: "core"; key: string }
	| { kind: "collection"; slug: string }
	| { kind: "taxonomy"; name: string }
	| { kind: "plugin"; pluginId: string; pagePath: string };

/**
 * Parse a navigation item id into its kind and reference.
 *
 * Plugin page paths are stored `encodeURIComponent`-encoded, so a valid
 * plugin id always splits into exactly three `:`-separated segments.
 */
export function parseAdminNavigationItemId(id: string): ParsedAdminNavigationItemId | undefined {
	if (id.length === 0 || id.length > ITEM_ID_MAX_LENGTH) return undefined;
	const segments = id.split(":");
	const [prefix, first, second] = segments;

	switch (prefix) {
		case "core":
			if (segments.length !== 2 || !first || !CORE_KEY_PATTERN.test(first)) return undefined;
			return { kind: "core", key: first };
		case "collection":
			if (
				segments.length !== 2 ||
				!first ||
				first.length > SLUG_MAX_LENGTH ||
				!SLUG_PATTERN.test(first)
			) {
				return undefined;
			}
			return { kind: "collection", slug: first };
		case "taxonomy":
			if (
				segments.length !== 2 ||
				!first ||
				first.length > SLUG_MAX_LENGTH ||
				!SLUG_PATTERN.test(first)
			) {
				return undefined;
			}
			return { kind: "taxonomy", name: first };
		case "plugin":
			if (segments.length !== 3 || !first || !PLUGIN_ID_PATTERN.test(first) || !second) {
				return undefined;
			}
			return { kind: "plugin", pluginId: first, pagePath: second };
		default:
			return undefined;
	}
}

export function isAdminNavigationItemId(value: string): value is AdminNavigationItemId {
	return parseAdminNavigationItemId(value) !== undefined;
}

export const adminNavigationItemIdSchema = z.custom<AdminNavigationItemId>(
	(value) => typeof value === "string" && isAdminNavigationItemId(value),
	"Invalid navigation item id",
);

export const adminNavigationGroupSchema = z
	.object({
		id: z
			.string()
			.regex(GROUP_ID_PATTERN, "Group id must be lowercase alphanumeric with dashes/underscores"),
		label: z.string().trim().min(1).max(80),
		order: z.number().int().min(0),
		collapsedByDefault: z.boolean().optional(),
	})
	.meta({ id: "AdminNavigationGroup" });

export const adminNavigationItemSchema = z
	.object({
		id: adminNavigationItemIdSchema,
		groupId: z
			.string()
			.regex(GROUP_ID_PATTERN, "Group id must be lowercase alphanumeric with dashes/underscores")
			.optional(),
		order: z.number().int().min(0).optional(),
		hidden: z.boolean().optional(),
	})
	.meta({ id: "AdminNavigationItem" });

export const adminNavigationConfigSchema = z
	.object({
		version: z.literal(1),
		groups: z.array(adminNavigationGroupSchema).max(100),
		items: z.array(adminNavigationItemSchema).max(1000),
	})
	.meta({ id: "AdminNavigationConfig" });

export type AdminNavigationGroupConfig = z.infer<typeof adminNavigationGroupSchema>;
export type AdminNavigationItemConfig = z.infer<typeof adminNavigationItemSchema>;
export type AdminNavigationConfigV1 = z.infer<typeof adminNavigationConfigSchema>;

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Validate and normalize a stored/submitted navigation config.
 *
 * Returns `undefined` when the input doesn't match the schema (including
 * unknown future versions — callers fall back to default navigation).
 *
 * Normal form, so semantically equal configs serialize identically (the
 * manifest hash depends on this):
 * - duplicate group/item ids: first occurrence wins
 * - `hidden` is only ever stored as `true`, and never on non-hideable items
 * - items carrying no placement info at all are dropped
 * - groups sort by (order, id); items sort by (groupId, order, id)
 */
export function normalizeAdminNavigationConfig(
	input: unknown,
): AdminNavigationConfigV1 | undefined {
	const parsed = adminNavigationConfigSchema.safeParse(input);
	if (!parsed.success) return undefined;

	const groups: AdminNavigationGroupConfig[] = [];
	const seenGroupIds = new Set<string>();
	for (const group of parsed.data.groups) {
		if (seenGroupIds.has(group.id)) continue;
		seenGroupIds.add(group.id);
		groups.push(group);
	}
	groups.sort((a, b) => a.order - b.order || compareStrings(a.id, b.id));

	const items: AdminNavigationItemConfig[] = [];
	const seenItemIds = new Set<string>();
	for (const item of parsed.data.items) {
		if (seenItemIds.has(item.id)) continue;
		seenItemIds.add(item.id);
		const entry: AdminNavigationItemConfig = { id: item.id };
		if (item.groupId !== undefined) entry.groupId = item.groupId;
		if (item.order !== undefined) entry.order = item.order;
		if (item.hidden === true && !NON_HIDEABLE_NAV_ITEM_IDS.has(item.id)) entry.hidden = true;
		if (entry.groupId === undefined && entry.order === undefined && entry.hidden === undefined) {
			continue;
		}
		items.push(entry);
	}
	items.sort(
		(a, b) =>
			compareStrings(a.groupId ?? "", b.groupId ?? "") ||
			(a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
			compareStrings(a.id, b.id),
	);

	return { version: 1, groups, items };
}
