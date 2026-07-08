import { Sidebar as KumoSidebar, useSidebar } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import {
	SquaresFour,
	FileText,
	Image,
	ChatCircle,
	Gear,
	PuzzlePiece,
	Storefront,
	Palette,
	Upload,
	Database,
	List,
	GridFour,
	Users,
	Stack,
	ArrowsLeftRight,
	ChartBar,
	ChartLine,
	ClockCounterClockwise,
	Medal,
	Trophy,
	Crop,
	BookOpen,
	Plug,
	Code,
	CalendarBlank,
	Bell,
	Folder,
	Star,
	Tag,
	LinkSimple,
	MagnifyingGlass,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import * as React from "react";

import { fetchCommentCounts } from "../lib/api/comments";
import { useCurrentUser } from "../lib/api/current-user";
import { resolvePluginPagePath, usePluginAdmins } from "../lib/plugin-context";
import { BrandIcon } from "./Logo.js";

// Re-export for Shell.tsx and Header.tsx
export { KumoSidebar as Sidebar, useSidebar };

// Role levels (matching @emdash-cms/auth)
const ROLE_ADMIN = 50;
const ROLE_EDITOR = 40;

/**
 * Static invariants for nav entries that have AC-level visibility
 * requirements (Phase 5 of Discussion #1174: "Admin sees the 'Byline
 * Schema' entry; Editor does not").
 *
 * Exported as plain data so a unit test can assert the route + role
 * pairing without mounting Kumo's Sidebar primitive — which portals
 * its rendered content to `document.body` and applies collapse-state
 * CSS (`display:none` on labels at narrow viewports), making
 * full-DOM tests of role filtering brittle. The runtime `adminItems`
 * array below references these constants directly so the test
 * effectively guards the production list.
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

export interface SidebarNavProps {
	manifest: {
		collections: Record<string, { label: string }>;
		plugins: Record<
			string,
			{
				package?: string;
				enabled?: boolean;
				adminMode?: "react" | "blocks" | "none";
				adminPages?: Array<{
					path: string;
					label?: string;
					icon?: string;
				}>;
				dashboardWidgets?: Array<{ id: string; title?: string }>;
				version?: string;
			}
		>;
		taxonomies: Array<{
			name: string;
			label: string;
		}>;
		version?: string;
		commit?: string;
		marketplace?: string;
		registry?: {
			aggregatorUrl: string;
		};
		admin?: {
			logo?: string;
			siteName?: string;
			favicon?: string;
		};
	};
}

interface NavItem {
	to: string;
	label: string;
	icon: React.ElementType;
	params?: Record<string, string>;
	/** Minimum role level required to see this item */
	minRole?: number;
	/** Optional badge count (e.g., pending comments) */
	badge?: number;
}

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
 * Resolve a plugin page's `icon` name to a component.
 *
 * Resolution order:
 *   1. No icon → `PuzzlePiece` (the common icon-less page never suspends).
 *   2. A name in `NAV_ICON_MAP` → its statically-imported component (sync,
 *      already in the main bundle — no extra chunk for everyday icons).
 *   3. Anything else → the matching `@phosphor-icons/react` component, loaded
 *      lazily from a code-split chunk the first time it's used. This gives
 *      access to the entire Phosphor set without pulling it into the main
 *      bundle, and only loads when a plugin uses an icon outside the map.
 *      Names that don't exist in Phosphor fall back to `PuzzlePiece`.
 *
 * Case 3 returns a `React.lazy` component, so call sites must render the
 * result inside a `<React.Suspense>` boundary (see `NavMenuLink`). Exported
 * so a unit test can assert resolution without mounting the portal-heavy
 * Kumo Sidebar.
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
			const mod = (await import("@phosphor-icons/react")) as Record<string, unknown>;
			const Icon = mod[componentName] as React.ComponentType<{ className?: string }> | undefined;
			return { default: Icon ?? PuzzlePiece };
		});
		lazyIconCache.set(componentName, icon);
	}
	return icon;
}

/**
 * Navigation item rendered with Kumo's native Sidebar.MenuButton. Kumo's
 * LinkProvider maps the href to TanStack Router for client-side navigation.
 */
function NavMenuLink({ item, isActive }: { item: NavItem; isActive: boolean }) {
	const { state } = useSidebar();
	const Icon = item.icon;
	function IconComponent({ className }: { className?: string }) {
		return <NavIcon icon={Icon} className={className} />;
	}

	return (
		<KumoSidebar.MenuButton
			href={resolveItemPath(item)}
			active={isActive}
			tooltip={state === "collapsed" ? item.label : undefined}
			icon={IconComponent}
		>
			{item.label}
			{item.badge != null && item.badge > 0 && (
				<KumoSidebar.MenuBadge>{item.badge}</KumoSidebar.MenuBadge>
			)}
		</KumoSidebar.MenuButton>
	);
}

function NavIcon({ icon: Icon, className }: { icon: React.ElementType; className?: string }) {
	return (
		<React.Suspense fallback={<PuzzlePiece className={className} aria-hidden="true" />}>
			<Icon className={className} aria-hidden="true" />
		</React.Suspense>
	);
}

/** Resolves a nav item's route path by substituting $param placeholders. */
function resolveItemPath(item: NavItem): string {
	let path = item.to;
	if (item.params) {
		for (const [key, value] of Object.entries(item.params)) {
			path = path.replace(`$${key}`, value);
		}
	}
	return path;
}

/** Checks if a nav item is active based on the current router path. */
function isItemActive(itemPath: string, currentPath: string): boolean {
	return itemPath === "/"
		? currentPath === "/"
		: currentPath === itemPath || currentPath.startsWith(`${itemPath}/`);
}

/**
 * Admin sidebar navigation using kumo's Sidebar compound component.
 */
export function SidebarNav({ manifest }: SidebarNavProps) {
	const { t } = useLingui();
	const location = useLocation();
	const currentPath = location.pathname;
	const pluginAdmins = usePluginAdmins();

	const { data: user } = useCurrentUser();
	const userRole = user?.role ?? 0;

	// Fetch pending comment count for badge
	const { data: commentCounts } = useQuery({
		queryKey: ["commentCounts"],
		queryFn: fetchCommentCounts,
		staleTime: 60 * 1000,
		retry: false,
		enabled: userRole >= ROLE_EDITOR,
	});

	// --- Build nav item groups ---

	const contentItems: NavItem[] = [{ to: "/", label: t`Dashboard`, icon: SquaresFour }];
	for (const [name, config] of Object.entries(manifest.collections)) {
		contentItems.push({
			to: "/content/$collection",
			label: config.label,
			icon: FileText,
			params: { collection: name },
		});
	}
	contentItems.push({ to: "/media", label: t`Media`, icon: Image });

	const manageItems: NavItem[] = [
		{
			to: "/comments",
			label: t`Comments`,
			icon: ChatCircle,
			minRole: ROLE_EDITOR,
			badge: commentCounts?.pending,
		},
		{ to: "/menus", label: t`Menus`, icon: List, minRole: ROLE_EDITOR },
		{ to: "/redirects", label: t`Redirects`, icon: ArrowsLeftRight, minRole: ROLE_ADMIN },
		{ to: "/widgets", label: t`Widgets`, icon: GridFour, minRole: ROLE_EDITOR },
		{ to: "/sections", label: t`Sections`, icon: Stack, minRole: ROLE_EDITOR },
		...manifest.taxonomies.map((tax) => ({
			to: "/taxonomies/$taxonomy" as const,
			label: tax.label,
			icon: FileText,
			params: { taxonomy: tax.name },
			minRole: ROLE_EDITOR,
		})),
		{ to: "/bylines", label: t`Bylines`, icon: FileText, minRole: ROLE_EDITOR },
	];

	const adminItems: NavItem[] = [
		{ to: "/content-types", label: t`Content Types`, icon: Database, minRole: ROLE_ADMIN },
		{ ...BYLINE_SCHEMA_NAV_ITEM, label: t`Byline Schema`, icon: FileText },
		{ to: "/users", label: t`Users`, icon: Users, minRole: ROLE_ADMIN },
		{ to: "/plugins-manager", label: t`Plugins`, icon: PuzzlePiece, minRole: ROLE_ADMIN },
	];

	if (manifest.registry) {
		adminItems.push({
			to: "/plugins/marketplace",
			label: t`Registry`,
			icon: Storefront,
			minRole: ROLE_ADMIN,
		});
	} else if (manifest.marketplace) {
		adminItems.push({
			to: "/plugins/marketplace",
			label: t`Marketplace`,
			icon: Storefront,
			minRole: ROLE_ADMIN,
		});
	}

	if (manifest.marketplace) {
		adminItems.push({
			to: "/themes/marketplace",
			label: t`Themes`,
			icon: Palette,
			minRole: ROLE_ADMIN,
		});
	}

	adminItems.push(
		{ to: "/import/wordpress", label: t`Import`, icon: Upload, minRole: ROLE_ADMIN },
		{ to: "/settings", label: t`Settings`, icon: Gear, minRole: ROLE_ADMIN },
	);

	const pluginItems: NavItem[] = [];
	for (const [pluginId, config] of Object.entries(manifest.plugins)) {
		if (config.enabled === false) continue;
		if (config.adminPages && config.adminPages.length > 0) {
			const pluginPages = pluginAdmins[pluginId]?.pages;
			const isBlocksMode = config.adminMode === "blocks";
			for (const page of config.adminPages) {
				if (!isBlocksMode && !resolvePluginPagePath(pluginPages, page.path)) continue;
				const label =
					page.label ||
					pluginId
						.split("-")
						.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
						.join(" ");
				pluginItems.push({
					to: `/plugins/${pluginId}${page.path}`,
					label,
					icon: resolveNavIcon(page.icon),
				});
			}
		}
	}

	const visibleContent = filterNavItemsByRole(contentItems, userRole);
	const visibleManage = filterNavItemsByRole(manageItems, userRole);
	const visibleAdmin = filterNavItemsByRole(adminItems, userRole);
	const visiblePlugins = filterNavItemsByRole(pluginItems, userRole);

	function renderNavItems(items: NavItem[]) {
		return items.map((item, index) => {
			const itemPath = resolveItemPath(item);
			const active = isItemActive(itemPath, currentPath);
			return <NavMenuLink key={`${item.to}-${index}`} item={item} isActive={active} />;
		});
	}

	return (
		<KumoSidebar className="emdash-sidebar" aria-label={t`Admin navigation`}>
			<KumoSidebar.Header>
				<Link
					to="/"
					className="flex w-full min-w-0 items-center gap-2 px-3 py-1 group-data-[state=collapsed]/sidebar:justify-center group-data-[state=collapsed]/sidebar:px-0"
				>
					<BrandIcon
						logoUrl={manifest.admin?.logo}
						siteName={manifest.admin?.siteName}
						className="size-5 shrink-0"
						aria-hidden="true"
					/>
					<span className="font-semibold truncate group-data-[state=collapsed]/sidebar:hidden">
						{manifest.admin?.siteName || "EmDash"}
					</span>
				</Link>
			</KumoSidebar.Header>

			<KumoSidebar.Content>
				{/* Dashboard — standalone */}
				<KumoSidebar.Group className="mt-2 md:mt-1.5">
					<KumoSidebar.Menu>
						<NavMenuLink
							item={{ to: "/", label: t`Dashboard`, icon: SquaresFour }}
							isActive={isItemActive("/", currentPath)}
						/>
					</KumoSidebar.Menu>
				</KumoSidebar.Group>

				{/* Content — collections + media */}
				{visibleContent.length > 1 && (
					<KumoSidebar.Group>
						<KumoSidebar.GroupLabel>{t`Content`}</KumoSidebar.GroupLabel>
						<KumoSidebar.Menu>
							{renderNavItems(visibleContent.filter((i) => i.to !== "/"))}
						</KumoSidebar.Menu>
					</KumoSidebar.Group>
				)}

				{/* Manage — comments, menus, taxonomies, etc. */}
				{visibleManage.length > 0 && (
					<KumoSidebar.Group>
						<KumoSidebar.GroupLabel>{t`Manage`}</KumoSidebar.GroupLabel>
						<KumoSidebar.Menu>{renderNavItems(visibleManage)}</KumoSidebar.Menu>
					</KumoSidebar.Group>
				)}

				{/* Admin — content types, users, plugins, import */}
				{visibleAdmin.length > 0 && (
					<KumoSidebar.Group>
						<KumoSidebar.GroupLabel>{t`Admin`}</KumoSidebar.GroupLabel>
						<KumoSidebar.Menu>{renderNavItems(visibleAdmin)}</KumoSidebar.Menu>
					</KumoSidebar.Group>
				)}

				{/* Plugin pages */}
				{visiblePlugins.length > 0 && (
					<KumoSidebar.Group>
						<KumoSidebar.GroupLabel>{t`Plugins`}</KumoSidebar.GroupLabel>
						<KumoSidebar.Menu>{renderNavItems(visiblePlugins)}</KumoSidebar.Menu>
					</KumoSidebar.Group>
				)}
			</KumoSidebar.Content>

			<KumoSidebar.Footer>
				<p className="px-3 py-2 text-[11px] text-kumo-subtle group-data-[state=collapsed]/sidebar:hidden">
					{manifest.admin?.siteName || "EmDash CMS"} v{manifest.version || "0.0.0"}
					{manifest.commit && ` (${manifest.commit})`}
				</p>
			</KumoSidebar.Footer>
		</KumoSidebar>
	);
}
