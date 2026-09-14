import { Sidebar as KumoSidebar, useSidebar } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Gear, Palette, Storefront, Users } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import * as React from "react";

import { fetchCommentCounts } from "../lib/api/comments";
import { useCurrentUser } from "../lib/api/current-user";
import { resolvePluginPagePath, usePluginAdmins } from "../lib/plugin-context";
import {
	groupNavItems,
	taxonomyGroup,
	type GroupableNavItem,
	type NavEntry,
	type NavFolder,
} from "../lib/sidebar-groups.js";
import {
	resolveTaxonomyDefinitions,
	type LocalizedTaxonomyDefinition,
} from "../lib/taxonomy-definitions.js";
import {
	ADMIN_NAV_ICONS,
	getCollectionNavIcon,
	getTaxonomyNavIcon,
	resolveNavIcon,
	toPhosphorIconName,
} from "./admin-navigation-icons.js";
import { BrandIcon } from "./Logo.js";

// Re-export for Shell.tsx and Header.tsx
export { KumoSidebar as Sidebar, useSidebar };
export { resolveNavIcon, toPhosphorIconName };

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
	icon: ADMIN_NAV_ICONS.bylineSchema,
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

/**
 * Manifest collections that get an auto-generated sidebar entry and dashboard
 * quick action, in manifest order. Pure function — exported so tests can pin
 * the `hidden` contract without rendering the sidebar.
 *
 * A hidden collection is still shipped in the manifest and stays fully
 * routable at `/content/:collection`, so a plugin that owns the collection end
 * to end can steer editors to its own admin UI.
 */
export function visibleCollectionEntries<T extends { hidden?: boolean }>(
	collections: Record<string, T>,
): Array<[string, T]> {
	return Object.entries(collections).filter(([, config]) => !config.hidden);
}

export interface SidebarNavProps {
	manifest: {
		collections: Record<string, { label: string; hidden?: boolean; group?: string }>;
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
			id?: string;
			name: string;
			label: string;
			collections?: string[];
			locale?: string;
			translationGroup?: string | null;
		}>;
		i18n?: { defaultLocale: string; locales: string[] };
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

/** Locale-normalized taxonomy rows used by the global Manage navigation. */
export function getSidebarTaxonomies<T extends LocalizedTaxonomyDefinition>(
	taxonomies: readonly T[],
	activeLocale?: string,
	defaultLocale?: string,
): T[] {
	return resolveTaxonomyDefinitions(taxonomies, activeLocale, defaultLocale);
}

export interface NavItem extends GroupableNavItem {
	to: string;
	label: string;
	icon: React.ElementType;
	params?: Record<string, string>;
	search?: Record<string, string>;
	/** Minimum role level required to see this item */
	minRole?: number;
	/** Optional badge count (e.g., pending comments) */
	badge?: number;
}

/** Folder member order: collections, then their taxonomies. */
const GROUP_RANK = { collection: 0, taxonomy: 1 } as const;

const FOLDER_STATE_STORAGE_KEY = "emdash-sidebar-folders";

type FolderState = Record<string, boolean>;

/** Parse stored folder choices, dropping anything that is not a label → boolean map. */
export function parseFolderState(raw: string | null): FolderState {
	try {
		const parsed: unknown = JSON.parse(raw ?? "{}");
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		const state: FolderState = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === "boolean") state[key] = value;
		}
		return state;
	} catch {
		return {};
	}
}

function readFolderState(): FolderState {
	if (typeof window === "undefined") return {};
	try {
		return parseFolderState(window.localStorage.getItem(FOLDER_STATE_STORAGE_KEY));
	} catch {
		return {};
	}
}

function writeFolderState(state: FolderState): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(FOLDER_STATE_STORAGE_KEY, JSON.stringify(state));
	} catch {}
}

/**
 * Open/closed choices the user made per folder label, remembered across
 * visits. A folder without a stored choice opens while it contains the
 * active item.
 */
export function useFolderState() {
	const [state, setState] = React.useState<FolderState>(readFolderState);
	const setOpen = React.useCallback((label: string, open: boolean) => {
		setState((prev) => {
			const next = { ...prev, [label]: open };
			writeFolderState(next);
			return next;
		});
	}, []);
	return { state, setOpen };
}

/**
 * Navigation item rendered with Kumo's native Sidebar.MenuButton. Kumo's
 * LinkProvider maps the href to TanStack Router for client-side navigation.
 */
function NavMenuLink({ item, isActive }: { item: NavItem; isActive: boolean }) {
	const { state } = useSidebar();
	const Icon = item.icon;
	function IconComponent({ className }: { className?: string }) {
		return <NavIcon icon={Icon} className={className} isActive={isActive} />;
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

/**
 * Collapsible folder of nav items. In the icon-only sidebar the folder links
 * straight to its active member (or the first one), since sub-menus have no
 * room to expand. The collapsible is fully controlled: only a click on the
 * folder button changes the stored choice, so Kumo's focus-driven expansion
 * is not recorded as a preference.
 */
export function NavFolderMenu({
	folder,
	currentPath,
	open,
	onToggle,
}: {
	folder: NavFolder<NavItem>;
	currentPath: string;
	open: boolean;
	onToggle: () => void;
}) {
	const { state } = useSidebar();
	const Icon = ADMIN_NAV_ICONS.folder;
	const members = folder.items.map((item) => {
		const path = resolveItemPath(item);
		return { item, path, active: isItemActive(path, currentPath) };
	});
	const target = members.find((member) => member.active) ?? members[0];
	if (!target) return null;
	const containsActive = target.active;

	if (state === "collapsed") {
		return (
			<NavMenuLink
				item={{ ...target.item, label: folder.label, icon: Icon }}
				isActive={containsActive}
			/>
		);
	}

	function IconComponent({ className }: { className?: string }) {
		return <NavIcon icon={Icon} className={className} isActive={containsActive} />;
	}

	return (
		<KumoSidebar.MenuItem>
			<KumoSidebar.Collapsible open={open}>
				<KumoSidebar.CollapsibleTrigger
					render={
						<KumoSidebar.MenuButton
							icon={IconComponent}
							active={containsActive && !open}
							onClick={onToggle}
						>
							{folder.label}
							<KumoSidebar.MenuChevron />
						</KumoSidebar.MenuButton>
					}
				/>
				<KumoSidebar.CollapsibleContent>
					<KumoSidebar.MenuSub>
						{members.map(({ item, path, active }) => (
							<KumoSidebar.MenuSubButton key={path} href={path} active={active}>
								{item.label}
							</KumoSidebar.MenuSubButton>
						))}
					</KumoSidebar.MenuSub>
				</KumoSidebar.CollapsibleContent>
			</KumoSidebar.Collapsible>
		</KumoSidebar.MenuItem>
	);
}

export function NavIcon({
	icon: Icon,
	className,
	isActive,
}: {
	icon: React.ElementType;
	className?: string;
	isActive: boolean;
}) {
	const weight = isActive ? "fill" : "regular";

	return (
		<React.Suspense
			fallback={
				<ADMIN_NAV_ICONS.plugins className={className} weight={weight} aria-hidden="true" />
			}
		>
			<Icon className={className} weight={weight} aria-hidden="true" />
		</React.Suspense>
	);
}

/**
 * Resolve the display label for a plugin admin page (sidebar + command
 * palette). Declared labels are run through the shared Lingui instance:
 * plugins that load their own catalog — with the English label as msgid —
 * get localized nav items. The catalog is shared with the admin, so common
 * labels like "Settings" pick up the admin's own translations even without
 * a plugin catalog (deliberate: a localized admin shouldn't show stray
 * English nav items). Labels with no catalog entry anywhere fall back to
 * the literal string. Pages without a label prettify the plugin id
 * ("my-shop" → "My Shop").
 */
export function resolvePluginPageLabel(
	label: string | undefined,
	pluginId: string,
	translate: (id: string) => string,
): string {
	if (label) return translate(label);
	return pluginId
		.split("-")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

/** Resolves a nav item's route path by substituting $param placeholders. */
export function resolveItemPath(item: NavItem): string {
	let path = item.to;
	if (item.params) {
		for (const [key, value] of Object.entries(item.params)) {
			path = path.replace(`$${key}`, value);
		}
	}
	if (item.search && Object.keys(item.search).length > 0) {
		path += `?${new URLSearchParams(item.search).toString()}`;
	}
	return path;
}

/** Checks if a nav item is active based on the current router path. */
export function isItemActive(itemPath: string, currentPath: string): boolean {
	const queryIndex = itemPath.indexOf("?");
	const path = queryIndex === -1 ? itemPath : itemPath.slice(0, queryIndex);
	return path === "/"
		? currentPath === "/"
		: currentPath === path || currentPath.startsWith(`${path}/`);
}

/**
 * Admin sidebar navigation using kumo's Sidebar compound component.
 */
export function SidebarNav({ manifest }: SidebarNavProps) {
	const { t, i18n } = useLingui();
	const location = useLocation();
	const currentPath = location.pathname;
	const routeLocale =
		new URL(location.href, "http://emdash.local").searchParams.get("locale") ?? undefined;
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

	const contentItems: NavItem[] = [
		{ to: "/", label: t`Dashboard`, icon: ADMIN_NAV_ICONS.dashboard },
	];
	for (const [name, config] of visibleCollectionEntries(manifest.collections)) {
		contentItems.push({
			to: "/content/$collection",
			label: config.label,
			icon: getCollectionNavIcon(name),
			group: config.group,
			groupRank: GROUP_RANK.collection,
			params: { collection: name },
		});
	}
	contentItems.push({ to: "/media", label: t`Media`, icon: ADMIN_NAV_ICONS.media });

	const collectionGroups = new Map(
		visibleCollectionEntries(manifest.collections).map(([name, config]) => [name, config.group]),
	);

	const manageItems: NavItem[] = [
		{
			to: "/comments",
			label: t`Comments`,
			icon: ADMIN_NAV_ICONS.comments,
			minRole: ROLE_EDITOR,
			badge: commentCounts?.pending,
		},
		{ to: "/menus", label: t`Menus`, icon: ADMIN_NAV_ICONS.menus, minRole: ROLE_EDITOR },
		{
			to: "/redirects",
			label: t`Redirects`,
			icon: ADMIN_NAV_ICONS.redirects,
			minRole: ROLE_ADMIN,
		},
		{ to: "/widgets", label: t`Widgets`, icon: ADMIN_NAV_ICONS.widgets, minRole: ROLE_EDITOR },
		{ to: "/sections", label: t`Sections`, icon: ADMIN_NAV_ICONS.sections, minRole: ROLE_EDITOR },
		{ to: "/bylines", label: t`Bylines`, icon: ADMIN_NAV_ICONS.bylines, minRole: ROLE_EDITOR },
	];
	for (const tax of getSidebarTaxonomies(
		manifest.taxonomies,
		routeLocale,
		manifest.i18n?.defaultLocale,
	)) {
		const item: NavItem = {
			to: "/taxonomies/$taxonomy",
			label: tax.label,
			icon: getTaxonomyNavIcon(tax.name),
			params: { taxonomy: tax.name },
			search: routeLocale ? { locale: routeLocale } : undefined,
			minRole: ROLE_EDITOR,
		};
		const group = taxonomyGroup(tax.collections ?? [], collectionGroups);
		if (group) {
			contentItems.push({ ...item, group, groupRank: GROUP_RANK.taxonomy });
		} else {
			manageItems.splice(manageItems.length - 1, 0, item);
		}
	}

	const adminItems: NavItem[] = [
		{
			to: "/content-types",
			label: t`Content Types`,
			icon: ADMIN_NAV_ICONS.contentTypes,
			minRole: ROLE_ADMIN,
		},
		{ ...BYLINE_SCHEMA_NAV_ITEM, label: t`Byline Schema` },
		{ to: "/users", label: t`Users`, icon: Users, minRole: ROLE_ADMIN },
		{
			to: "/plugins-manager",
			label: t`Plugins`,
			icon: ADMIN_NAV_ICONS.plugins,
			minRole: ROLE_ADMIN,
		},
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
		{
			to: "/import/wordpress",
			label: t`Import`,
			icon: ADMIN_NAV_ICONS.import,
			minRole: ROLE_ADMIN,
		},
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
				const label = resolvePluginPageLabel(page.label, pluginId, (id) => i18n._(id));
				pluginItems.push({
					to: `/plugins/${pluginId}${page.path}`,
					label,
					icon: resolveNavIcon(page.icon),
				});
			}
		}
	}

	const visibleContent = groupNavItems(
		filterNavItemsByRole(contentItems, userRole).filter((i) => i.to !== "/"),
	);
	const visibleManage = filterNavItemsByRole(manageItems, userRole);
	const visibleAdmin = filterNavItemsByRole(adminItems, userRole);
	const visiblePlugins = filterNavItemsByRole(pluginItems, userRole);

	const folders = useFolderState();

	function renderNavItems(items: NavItem[]) {
		return items.map((item, index) => {
			const itemPath = resolveItemPath(item);
			const active = isItemActive(itemPath, currentPath);
			return <NavMenuLink key={`${item.to}-${index}`} item={item} isActive={active} />;
		});
	}

	function renderNavEntries(entries: NavEntry<NavItem>[]) {
		return entries.map((entry, index) => {
			if (entry.kind === "item") {
				const itemPath = resolveItemPath(entry.item);
				return (
					<NavMenuLink
						key={`${entry.item.to}-${index}`}
						item={entry.item}
						isActive={isItemActive(itemPath, currentPath)}
					/>
				);
			}
			const open =
				folders.state[entry.label] ??
				entry.items.some((item) => isItemActive(resolveItemPath(item), currentPath));
			return (
				<NavFolderMenu
					key={`folder-${entry.label}`}
					folder={entry}
					currentPath={currentPath}
					open={open}
					onToggle={() => folders.setOpen(entry.label, !open)}
				/>
			);
		});
	}

	return (
		<KumoSidebar className="emdash-sidebar" aria-label={t`Admin navigation`}>
			<KumoSidebar.Header className="px-[11px] transition-[padding] duration-(--sidebar-animation-duration) motion-reduce:transition-none group-not-data-[state=collapsed]/sidebar:px-3.5">
				<Link
					to="/"
					className="flex w-[calc(var(--sidebar-width)-1.75rem)] shrink-0 items-center gap-2 overflow-hidden py-1 ps-2.5 group-data-[state=collapsed]/sidebar:-translate-x-[3px] rtl:group-data-[state=collapsed]/sidebar:translate-x-[3px]"
				>
					<BrandIcon
						logoUrl={manifest.admin?.logo}
						siteName={manifest.admin?.siteName}
						className="size-5 shrink-0"
						aria-hidden="true"
					/>
					<span className="grid min-w-0 flex-1 grid-cols-[1fr] transition-[grid-template-columns] duration-(--sidebar-animation-duration) ease-(--sidebar-easing) motion-reduce:transition-none group-data-[state=collapsed]/sidebar:grid-cols-[0fr]">
						<span className="min-w-0 overflow-hidden">
							<span className="block w-[calc(var(--sidebar-width)-4.5rem)] truncate font-semibold">
								{manifest.admin?.siteName || "EmDash"}
							</span>
						</span>
					</span>
				</Link>
			</KumoSidebar.Header>

			<KumoSidebar.Content>
				{/* Dashboard — standalone */}
				<KumoSidebar.Group className="mt-2 md:mt-1.5">
					<KumoSidebar.Menu>
						<NavMenuLink
							item={{ to: "/", label: t`Dashboard`, icon: ADMIN_NAV_ICONS.dashboard }}
							isActive={isItemActive("/", currentPath)}
						/>
					</KumoSidebar.Menu>
				</KumoSidebar.Group>

				{/* Content — collections + media */}
				{visibleContent.length > 1 && (
					<KumoSidebar.Group>
						<KumoSidebar.GroupLabel>{t`Content`}</KumoSidebar.GroupLabel>
						<KumoSidebar.Menu>{renderNavEntries(visibleContent)}</KumoSidebar.Menu>
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

			<KumoSidebar.Footer className="gap-0">
				<KumoSidebar.Trigger className="rtl:rotate-180" />
				<div className="min-w-0 flex-1 overflow-hidden">
					<p
						data-testid="admin-version"
						className="w-40 overflow-hidden truncate ps-2 text-[11px] text-kumo-subtle"
					>
						{manifest.admin?.siteName || "EmDash CMS"} v{manifest.version || "0.0.0"}
						{manifest.commit && ` (${manifest.commit})`}
					</p>
				</div>
			</KumoSidebar.Footer>
		</KumoSidebar>
	);
}
