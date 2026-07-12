/**
 * Shared admin navigation model.
 *
 * Single source of truth for what appears in the sidebar and the command
 * palette. Builds the default groups (matching the classic hardcoded
 * sidebar), then applies the site's optional navigation config from the
 * manifest — custom groups, ordering, hiding. Pure module (no hooks, no
 * fetching) so both consumers render identical data and tests need no DOM.
 *
 * Grouping is presentation only. Hiding removes the sidebar entry but the
 * item stays reachable by URL and searchable in the command palette; role
 * gating (`minRole`) is the only visibility rule with security meaning,
 * and it applies before any config.
 */

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import {
	ArrowsLeftRight,
	Bell,
	BookOpen,
	CalendarBlank,
	ChartBar,
	ChartLine,
	ChatCircle,
	ClockCounterClockwise,
	Code,
	Crop,
	Database,
	FileText,
	Folder,
	Gear,
	GridFour,
	Image,
	LinkSimple,
	List,
	MagnifyingGlass,
	Medal,
	Palette,
	Plug,
	PuzzlePiece,
	SidebarSimple,
	SquaresFour,
	Stack,
	Star,
	Storefront,
	Tag,
	Trophy,
	Upload,
	Users,
} from "@phosphor-icons/react";
import * as React from "react";

import { resolvePluginPagePath, type PluginAdmins } from "./plugin-context";

// Role levels (matching @emdash-cms/auth)
export const ROLE_ADMIN = 50;
export const ROLE_EDITOR = 40;

/**
 * Static invariants for nav entries that have AC-level visibility
 * requirements (Phase 5 of Discussion #1174: "Admin sees the 'Byline
 * Schema' entry; Editor does not").
 *
 * Exported as plain data so a unit test can assert the route + role
 * pairing without mounting Kumo's Sidebar primitive. The runtime nav
 * model references this constant directly so the test effectively
 * guards the production list.
 */
export const BYLINE_SCHEMA_NAV_ITEM = {
	to: "/byline-schema" as const,
	minRole: ROLE_ADMIN,
} as const;

/**
 * Filter a nav-items list by user role. Pure function — exported so
 * tests can verify the role gate without rendering the sidebar. An
 * item passes when it has no `minRole` (public) or the user is at
 * least the required level.
 */
export function filterNavItemsByRole<T extends { minRole?: number }>(
	items: T[],
	userRole: number,
): T[] {
	return items.filter((item) => !item.minRole || userRole >= item.minRole);
}

// ── Icon resolution ─────────────────────────────────────────────

/**
 * Static map of common plugin admin-page icon names to Phosphor components.
 *
 * Plugins declare `adminPages: [{ path, label, icon }]`, where `icon` is a
 * lower/kebab name. This table covers the names used across the EmDash
 * docs/templates (including lucide-style names like `settings`/`chart` that
 * don't match Phosphor's own naming) plus common nav glyphs. These are
 * statically imported, so the everyday case resolves *synchronously* and the
 * handful of components ship in the main bundle — the full Phosphor set is
 * never pulled in for them. Any name not listed here is resolved lazily
 * (see `resolveNavIcon`), so there is no hard ceiling.
 */
const NAV_ICON_MAP: Record<string, React.ElementType> = {
	// Documented in the plugin docs & "creating-plugins" skill
	settings: Gear,
	gear: Gear,
	chart: ChartBar,
	"chart-line": ChartLine,
	dashboard: SquaresFour,
	history: ClockCounterClockwise,
	image: Image,
	// Used by template / first-party plugins
	award: Medal,
	trophy: Trophy,
	grid: GridFour,
	crop: Crop,
	// Common admin-nav glyphs
	book: BookOpen,
	plug: Plug,
	code: Code,
	file: FileText,
	document: FileText,
	users: Users,
	database: Database,
	list: List,
	calendar: CalendarBlank,
	bell: Bell,
	folder: Folder,
	star: Star,
	tag: Tag,
	link: LinkSimple,
	search: MagnifyingGlass,
	palette: Palette,
	upload: Upload,
};

/** Word separators in icon names: kebab, snake, or whitespace. */
const ICON_NAME_SEPARATOR = /[-_\s]+/;

/**
 * Convert a kebab/snake/space icon name to Phosphor's PascalCase component
 * name (`chart-bar` → `ChartBar`). Exported for unit testing the pure mapping.
 */
export function toPhosphorIconName(name: string): string {
	return name
		.split(ICON_NAME_SEPARATOR)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join("");
}

/**
 * Cache of lazily-loaded icon components, keyed by Phosphor component name.
 * `React.lazy` must return a stable identity across renders (a fresh lazy
 * component on every render would remount and re-suspend), so memoize here.
 */
const lazyIconCache = new Map<string, React.ElementType>();

/**
 * Resolve an icon name (collection icon, plugin page icon) to a component.
 *
 * Resolution order:
 *   1. No icon → `PuzzlePiece` (the common icon-less case never suspends).
 *   2. A name in `NAV_ICON_MAP` → its statically-imported component (sync,
 *      already in the main bundle — no extra chunk for everyday icons).
 *   3. Anything else → the matching `@phosphor-icons/react` component, loaded
 *      lazily from a code-split chunk the first time it's used. This gives
 *      access to the entire Phosphor set without pulling it into the main
 *      bundle. Names that don't exist in Phosphor fall back to `PuzzlePiece`.
 *
 * Case 3 returns a `React.lazy` component, so call sites must render the
 * result inside a `<React.Suspense>` boundary.
 */
export function resolveNavIcon(name?: string): React.ElementType {
	if (!name) {
		return PuzzlePiece;
	}
	const mapped = NAV_ICON_MAP[name];
	if (mapped) {
		return mapped;
	}
	const componentName = toPhosphorIconName(name);
	let icon = lazyIconCache.get(componentName);
	if (!icon) {
		icon = React.lazy(async () => {
			const mod: Record<string, unknown> = await import("@phosphor-icons/react");
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Phosphor's by-name module map is untyped; unknown names fall back below
			const Icon = mod[componentName] as React.ComponentType<{ className?: string }> | undefined;
			return { default: Icon ?? PuzzlePiece };
		});
		lazyIconCache.set(componentName, icon);
	}
	return icon;
}

// ── Wire types (mirror packages/core api/schemas/admin-navigation.ts) ──

export interface AdminNavigationGroupConfig {
	id: string;
	label: string;
	order: number;
	collapsedByDefault?: boolean;
}

export interface AdminNavigationItemConfig {
	id: string;
	groupId?: string;
	order?: number;
	hidden?: boolean;
}

export interface AdminNavigationConfig {
	version: 1;
	groups: AdminNavigationGroupConfig[];
	items: AdminNavigationItemConfig[];
}

// ── Model types ─────────────────────────────────────────────────

export type AdminNavItemKind = "core" | "collection" | "taxonomy" | "plugin";

export interface AdminNavItem {
	/** Stable config id: `core:x`, `collection:slug`, `taxonomy:name`, `plugin:id:path`. */
	id: string;
	kind: AdminNavItemKind;
	/** Site data renders as-is (string); default labels are Lingui descriptors. */
	label: string | MessageDescriptor;
	to: string;
	params?: Record<string, string>;
	icon: React.ElementType;
	minRole?: number;
	badge?: number;
	/** False for lockout-protected items (dashboard, settings, organizer). */
	hideable: boolean;
	/** Search keywords for the command palette. */
	keywords: string[];
}

export interface AdminNavGroup {
	id: string;
	/** Absent for the standalone dashboard block (renders without a header). */
	label?: string | MessageDescriptor;
	collapsible: boolean;
	collapsedByDefault: boolean;
	items: AdminNavItem[];
}

export interface AdminNavModel {
	/** Role-filtered, hidden items removed, empty groups dropped, sorted. */
	groups: AdminNavGroup[];
	/** Role-visible items hidden from the sidebar — still palette-searchable. */
	hiddenItems: AdminNavItem[];
}

/** Structural subset of the admin manifest the nav model reads. */
export interface AdminNavManifestInput {
	collections: Record<string, { label: string; icon?: string }>;
	taxonomies: Array<{ name: string; label: string }>;
	plugins: Record<
		string,
		{
			enabled?: boolean;
			adminMode?: "react" | "blocks" | "none";
			adminPages?: Array<{ path: string; label?: string; icon?: string }>;
		}
	>;
	marketplace?: unknown;
	registry?: unknown;
	adminNavigation?: AdminNavigationConfig;
}

export interface BuildAdminNavModelOptions {
	userRole: number;
	/** Pending-comment count for the Comments badge. */
	pendingComments?: number;
	/**
	 * Loaded plugin admin modules. React-mode plugin pages only render once
	 * their page component resolves (same rule the sidebar always applied).
	 */
	pluginAdmins?: PluginAdmins;
}

// ── Defaults ────────────────────────────────────────────────────

const DASHBOARD_GROUP_ID = "dashboard";
const DASHBOARD_GROUP_ORDER = -1;

/**
 * Default groups carry implicit orders 100/200/300/400 so config groups can
 * interleave anywhere between them (and re-order the defaults themselves by
 * overriding the same group id).
 */
const DEFAULT_GROUPS: ReadonlyArray<{ id: string; label: MessageDescriptor; order: number }> = [
	{ id: "content", label: msg`Content`, order: 100 },
	{ id: "manage", label: msg`Manage`, order: 200 },
	{ id: "admin", label: msg`Admin`, order: 300 },
	{ id: "plugins", label: msg`Plugins`, order: 400 },
];

/**
 * Unconfigured items sort after configured ones inside a group, keeping
 * their default relative order. The organizer writes explicit orders on
 * save, so this only shapes hand-written or partial configs.
 */
const UNCONFIGURED_ITEM_ORDER_BASE = 10_000;

/** Mirrors NON_HIDEABLE_NAV_ITEM_IDS in core; enforced server-side too. */
export const NON_HIDEABLE_NAV_ITEM_IDS: ReadonlySet<string> = new Set([
	"core:dashboard",
	"core:settings",
	"core:navigation",
]);

interface PlacedNavItem extends AdminNavItem {
	defaultGroupId: string;
	defaultIndex: number;
}

function pluginPageLabel(pluginId: string, label?: string): string {
	return (
		label ||
		pluginId
			.split("-")
			.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
			.join(" ")
	);
}

/** Build every default nav item in default order, tagged with its default group. */
function buildDefaultItems(
	manifest: AdminNavManifestInput,
	opts: BuildAdminNavModelOptions,
): PlacedNavItem[] {
	const items: Omit<PlacedNavItem, "defaultIndex">[] = [];

	items.push({
		id: "core:dashboard",
		kind: "core",
		label: msg`Dashboard`,
		to: "/",
		icon: SquaresFour,
		hideable: false,
		keywords: ["home", "overview"],
		defaultGroupId: DASHBOARD_GROUP_ID,
	});

	for (const [name, collection] of Object.entries(manifest.collections)) {
		items.push({
			id: `collection:${name}`,
			kind: "collection",
			label: collection.label,
			to: "/content/$collection",
			params: { collection: name },
			icon: collection.icon ? resolveNavIcon(collection.icon) : FileText,
			hideable: true,
			keywords: ["content", name],
			defaultGroupId: "content",
		});
	}

	items.push({
		id: "core:media",
		kind: "core",
		label: msg`Media`,
		to: "/media",
		icon: Image,
		hideable: true,
		keywords: ["images", "files", "uploads", "library"],
		defaultGroupId: "content",
	});

	items.push(
		{
			id: "core:comments",
			kind: "core",
			label: msg`Comments`,
			to: "/comments",
			icon: ChatCircle,
			minRole: ROLE_EDITOR,
			badge: opts.pendingComments,
			hideable: true,
			keywords: ["moderation"],
			defaultGroupId: "manage",
		},
		{
			id: "core:menus",
			kind: "core",
			label: msg`Menus`,
			to: "/menus",
			icon: List,
			minRole: ROLE_EDITOR,
			hideable: true,
			keywords: ["navigation"],
			defaultGroupId: "manage",
		},
		{
			id: "core:redirects",
			kind: "core",
			label: msg`Redirects`,
			to: "/redirects",
			icon: ArrowsLeftRight,
			minRole: ROLE_ADMIN,
			hideable: true,
			keywords: ["urls"],
			defaultGroupId: "manage",
		},
		{
			id: "core:widgets",
			kind: "core",
			label: msg`Widgets`,
			to: "/widgets",
			icon: GridFour,
			minRole: ROLE_EDITOR,
			hideable: true,
			keywords: ["sidebar", "footer"],
			defaultGroupId: "manage",
		},
		{
			id: "core:sections",
			kind: "core",
			label: msg`Sections`,
			to: "/sections",
			icon: Stack,
			minRole: ROLE_EDITOR,
			hideable: true,
			keywords: ["page builder", "blocks"],
			defaultGroupId: "manage",
		},
	);

	for (const taxonomy of manifest.taxonomies) {
		items.push({
			id: `taxonomy:${taxonomy.name}`,
			kind: "taxonomy",
			label: taxonomy.label,
			to: "/taxonomies/$taxonomy",
			params: { taxonomy: taxonomy.name },
			icon: Tag,
			minRole: ROLE_EDITOR,
			hideable: true,
			keywords: ["taxonomy", taxonomy.name],
			defaultGroupId: "manage",
		});
	}

	items.push(
		{
			id: "core:bylines",
			kind: "core",
			label: msg`Bylines`,
			to: "/bylines",
			icon: FileText,
			minRole: ROLE_EDITOR,
			hideable: true,
			keywords: ["authors"],
			defaultGroupId: "manage",
		},
		{
			id: "core:content-types",
			kind: "core",
			label: msg`Content Types`,
			to: "/content-types",
			icon: Database,
			minRole: ROLE_ADMIN,
			hideable: true,
			keywords: ["schema", "collections"],
			defaultGroupId: "admin",
		},
		{
			id: "core:byline-schema",
			kind: "core",
			label: msg`Byline Schema`,
			to: BYLINE_SCHEMA_NAV_ITEM.to,
			icon: FileText,
			minRole: BYLINE_SCHEMA_NAV_ITEM.minRole,
			hideable: true,
			keywords: ["authors", "schema"],
			defaultGroupId: "admin",
		},
		{
			id: "core:users",
			kind: "core",
			label: msg`Users`,
			to: "/users",
			icon: Users,
			minRole: ROLE_ADMIN,
			hideable: true,
			keywords: ["accounts", "team"],
			defaultGroupId: "admin",
		},
		{
			id: "core:plugins-manager",
			kind: "core",
			label: msg`Plugins`,
			to: "/plugins-manager",
			icon: PuzzlePiece,
			minRole: ROLE_ADMIN,
			hideable: true,
			keywords: ["extensions", "add-ons"],
			defaultGroupId: "admin",
		},
	);

	if (manifest.registry) {
		items.push({
			id: "core:marketplace",
			kind: "core",
			label: msg`Registry`,
			to: "/plugins/marketplace",
			icon: Storefront,
			minRole: ROLE_ADMIN,
			hideable: true,
			keywords: ["plugins", "marketplace", "registry"],
			defaultGroupId: "admin",
		});
	} else if (manifest.marketplace) {
		items.push({
			id: "core:marketplace",
			kind: "core",
			label: msg`Marketplace`,
			to: "/plugins/marketplace",
			icon: Storefront,
			minRole: ROLE_ADMIN,
			hideable: true,
			keywords: ["plugins", "marketplace"],
			defaultGroupId: "admin",
		});
	}

	if (manifest.marketplace) {
		items.push({
			id: "core:themes",
			kind: "core",
			label: msg`Themes`,
			to: "/themes/marketplace",
			icon: Palette,
			minRole: ROLE_ADMIN,
			hideable: true,
			keywords: ["appearance"],
			defaultGroupId: "admin",
		});
	}

	items.push(
		{
			id: "core:import-wordpress",
			kind: "core",
			label: msg`Import`,
			to: "/import/wordpress",
			icon: Upload,
			minRole: ROLE_ADMIN,
			hideable: true,
			keywords: ["wordpress", "migrate"],
			defaultGroupId: "admin",
		},
		{
			id: "core:settings",
			kind: "core",
			label: msg`Settings`,
			to: "/settings",
			icon: Gear,
			minRole: ROLE_ADMIN,
			hideable: false,
			keywords: ["configuration", "preferences"],
			defaultGroupId: "admin",
		},
		{
			id: "core:navigation",
			kind: "core",
			label: msg`Navigation`,
			to: "/settings/navigation",
			icon: SidebarSimple,
			minRole: ROLE_ADMIN,
			hideable: false,
			keywords: ["sidebar", "navigation", "groups"],
			defaultGroupId: "admin",
		},
	);

	for (const [pluginId, plugin] of Object.entries(manifest.plugins)) {
		if (plugin.enabled === false) continue;
		if (!plugin.adminPages || plugin.adminPages.length === 0) continue;
		const pluginPages = opts.pluginAdmins?.[pluginId]?.pages;
		const isBlocksMode = plugin.adminMode === "blocks";
		for (const page of plugin.adminPages) {
			if (!isBlocksMode && !resolvePluginPagePath(pluginPages, page.path)) continue;
			items.push({
				id: `plugin:${pluginId}:${encodeURIComponent(page.path)}`,
				kind: "plugin",
				label: pluginPageLabel(pluginId, page.label),
				to: `/plugins/${pluginId}${page.path}`,
				icon: resolveNavIcon(page.icon),
				hideable: true,
				keywords: ["plugin", pluginId],
				defaultGroupId: "plugins",
			});
		}
	}

	return items.map((item, index) => ({ ...item, defaultIndex: index }));
}

// ── Model builder ───────────────────────────────────────────────

interface GroupDef {
	id: string;
	label?: string | MessageDescriptor;
	order: number;
	collapsedByDefault: boolean;
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Build the navigation model for the current manifest, user, and site
 * config. With no config this reproduces the classic sidebar exactly
 * (plus the Navigation organizer entry under Admin).
 */
export function buildAdminNavModel(
	manifest: AdminNavManifestInput,
	opts: BuildAdminNavModelOptions,
): AdminNavModel {
	const config = manifest.adminNavigation;
	const visibleItems = filterNavItemsByRole(buildDefaultItems(manifest, opts), opts.userRole);

	// Group definitions: dashboard block + defaults, overlaid by config
	// groups (same id overrides label/order/collapse of a default group).
	const groupDefs = new Map<string, GroupDef>();
	groupDefs.set(DASHBOARD_GROUP_ID, {
		id: DASHBOARD_GROUP_ID,
		order: DASHBOARD_GROUP_ORDER,
		collapsedByDefault: false,
	});
	for (const group of DEFAULT_GROUPS) {
		groupDefs.set(group.id, {
			id: group.id,
			label: group.label,
			order: group.order,
			collapsedByDefault: false,
		});
	}
	for (const group of config?.groups ?? []) {
		groupDefs.set(group.id, {
			id: group.id,
			label: group.label,
			order: group.order,
			collapsedByDefault: group.collapsedByDefault ?? false,
		});
	}

	const itemConfigById = new Map<string, AdminNavigationItemConfig>();
	for (const item of config?.items ?? []) {
		if (!itemConfigById.has(item.id)) itemConfigById.set(item.id, item);
	}

	const hiddenItems: AdminNavItem[] = [];
	const placedByGroup = new Map<
		string,
		Array<{ item: AdminNavItem; sortKey: number; defaultIndex: number }>
	>();

	for (const placed of visibleItems) {
		const { defaultGroupId, defaultIndex, ...item } = placed;
		const itemConfig = itemConfigById.get(item.id);

		if (itemConfig?.hidden && item.hideable) {
			hiddenItems.push(item);
			continue;
		}

		// A groupId pointing at a group that no longer exists falls back to
		// the item's default group — stale config never loses items.
		const groupId =
			itemConfig?.groupId && groupDefs.has(itemConfig.groupId)
				? itemConfig.groupId
				: defaultGroupId;
		const sortKey = itemConfig?.order ?? UNCONFIGURED_ITEM_ORDER_BASE + defaultIndex;

		let bucket = placedByGroup.get(groupId);
		if (!bucket) {
			bucket = [];
			placedByGroup.set(groupId, bucket);
		}
		bucket.push({ item, sortKey, defaultIndex });
	}

	const groups: AdminNavGroup[] = [];
	const sortedDefs = [...groupDefs.values()].toSorted(
		(a, b) => a.order - b.order || compareStrings(a.id, b.id),
	);
	for (const def of sortedDefs) {
		const bucket = placedByGroup.get(def.id);
		if (!bucket || bucket.length === 0) continue;
		bucket.sort(
			(a, b) =>
				a.sortKey - b.sortKey ||
				a.defaultIndex - b.defaultIndex ||
				compareStrings(a.item.id, b.item.id),
		);
		groups.push({
			id: def.id,
			label: def.label,
			collapsible: def.label !== undefined,
			collapsedByDefault: def.collapsedByDefault,
			items: bucket.map((entry) => entry.item),
		});
	}

	return { groups, hiddenItems };
}

/**
 * Flatten the model for the command palette. Hidden-from-sidebar items are
 * included by default — the palette is the recovery path for hidden items.
 */
export function flattenAdminNavModel(
	model: AdminNavModel,
	options?: { includeHidden?: boolean },
): AdminNavItem[] {
	const items = model.groups.flatMap((group) => group.items);
	if (options?.includeHidden === false) return items;
	return [...items, ...model.hiddenItems];
}

// ── Per-user collapse state (localStorage) ──────────────────────

export const NAV_COLLAPSE_STORAGE_KEY = "emdash:admin-nav:v1";

export interface NavCollapseState {
	/** Groups the user explicitly collapsed. */
	collapsedGroupIds: string[];
	/** Groups the user explicitly expanded (overrides `collapsedByDefault`). */
	expandedGroupIds: string[];
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Parse stored collapse state; malformed data reads as empty state. */
export function parseNavCollapseState(raw: string | null): NavCollapseState {
	const empty: NavCollapseState = { collapsedGroupIds: [], expandedGroupIds: [] };
	if (!raw) return empty;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return empty;
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- values are re-validated field-by-field below
		const record = parsed as Record<string, unknown>;
		return {
			collapsedGroupIds: isStringArray(record.collapsedGroupIds) ? record.collapsedGroupIds : [],
			expandedGroupIds: isStringArray(record.expandedGroupIds) ? record.expandedGroupIds : [],
		};
	} catch {
		return empty;
	}
}

export function serializeNavCollapseState(state: NavCollapseState): string {
	return JSON.stringify(state);
}

/**
 * Whether a group renders collapsed: an explicit user choice wins in either
 * direction; otherwise the group's `collapsedByDefault` applies.
 */
export function isGroupCollapsed(group: AdminNavGroup, state: NavCollapseState): boolean {
	if (!group.collapsible) return false;
	if (state.collapsedGroupIds.includes(group.id)) return true;
	if (state.expandedGroupIds.includes(group.id)) return false;
	return group.collapsedByDefault;
}

/** Return the next collapse state after the user toggles a group. */
export function toggleGroupCollapsed(
	state: NavCollapseState,
	groupId: string,
	collapsed: boolean,
): NavCollapseState {
	return {
		collapsedGroupIds: collapsed
			? [...new Set([...state.collapsedGroupIds, groupId])]
			: state.collapsedGroupIds.filter((id) => id !== groupId),
		expandedGroupIds: collapsed
			? state.expandedGroupIds.filter((id) => id !== groupId)
			: [...new Set([...state.expandedGroupIds, groupId])],
	};
}
