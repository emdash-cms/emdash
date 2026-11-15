import { Sidebar as KumoSidebar, Tooltip, useSidebar } from "@cloudflare/kumo";
import { isSafePluginPagePath, normalizePluginPagePath } from "@emdash-cms/blocks";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui as useLinguiContext } from "@lingui/react";
import { useLingui } from "@lingui/react/macro";
import { Gear, PencilSimple, Storefront, Users } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import * as React from "react";

import { navPathId, resolveNav, type LayoutNavGroup } from "../lib/admin-layout.js";
import { formatAdminVersion } from "../lib/admin-version.js";
import { useAdminLayout } from "../lib/api/admin-layout.js";
import { fetchCommentCounts } from "../lib/api/comments";
import { useCurrentUser } from "../lib/api/current-user";
import { resolvePluginPagePath, usePluginAdmins, type PluginAdmins } from "../lib/plugin-context";
import {
	groupNavItems,
	joinsContentFolder,
	normalizeGroup,
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
import { RouterLinkButton } from "./RouterLinkButton.js";

// Re-export for Shell.tsx and Header.tsx
export { KumoSidebar as Sidebar, useSidebar };
export { resolveNavIcon, toPhosphorIconName };

// Role levels (matching @emdash-cms/auth)
const ROLE_ADMIN = 50;
const ROLE_EDITOR = 40;
const ROLE_CONTRIBUTOR = 20;

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

function filterHiddenNavItems<T extends { navId?: string }>(
	items: T[],
	hidden: readonly string[] | undefined,
): T[] {
	if (!hidden?.length) return items;
	return items.filter((item) => !item.navId || !hidden.includes(item.navId));
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
		collections: Record<string, { label: string; hidden?: boolean; icon?: string; group?: string }>;
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
					group?: string;
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
		marketplace?: boolean;
		registry?: {
			aggregatorUrl: string;
		};
		admin?: {
			logo?: string;
			siteName?: string;
			footerLabel?: string | false;
			favicon?: string;
			hiddenNavItems?: string[];
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
	/** Name under which `admin.hiddenNavItems` can hide this built-in entry */
	navId?: string;
}

/** Folder member order: collections, then their taxonomies, then plugin pages. */
const GROUP_RANK = { collection: 0, taxonomy: 1, pluginPage: 2 } as const;

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
	const Icon = resolveNavIcon(folder.iconName, ADMIN_NAV_ICONS.folder);
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
 * palette). Declared labels are translated only when the active catalog has
 * an entry for them; otherwise they are returned as declared. Plugins that
 * load their own catalog — with the English label as msgid — get localized
 * nav items. Pages without a label prettify the plugin id ("my-shop" → "My Shop").
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

/**
 * Resolve the display title for a plugin dashboard widget. Declared titles
 * are run through the shared Lingui instance so a plugin-provided catalog
 * localizes dashboard card headings the same way it localizes sidebar nav
 * labels. Widgets without a title fall back to the raw widget id.
 */
export function resolvePluginWidgetTitle(
	title: string | undefined,
	widgetId: string,
	translate: (id: string) => string,
): string {
	if (title) return translate(title);
	return widgetId;
}

/**
 * Wrap `translate` so a declared label reaches it only when the active catalog
 * has an entry for it; any other label is returned as declared. Most plugin
 * labels have no catalog entry, and passing one to Lingui logs an
 * "Uncompiled message detected" warning on every render.
 */
export function declaredLabelTranslator(
	i18n: Pick<I18n, "messages">,
	translate: (id: string) => string,
): (id: string) => string {
	return (id) => (i18n.messages[id] === undefined ? id : translate(id));
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

const TRAILING_SLASHES = /\/+$/;

/**
 * Drop trailing slashes so a target and the router's path compare equal.
 * "/" keeps its meaning: it is the admin root, not an empty path.
 */
function stripTrailingSlash(value: string): string {
	return value.length > 1 ? value.replace(TRAILING_SLASHES, "") : value;
}

/**
 * Checks if a nav item is active based on the current router path.
 *
 * Both sides are normalized because a plugin page declared with `path: "/"`
 * makes the target `/plugins/<id>/`, while the router navigates to the same
 * URL without the trailing slash — an exact compare would never match.
 */
export function isItemActive(itemPath: string, currentPath: string): boolean {
	const queryIndex = itemPath.indexOf("?");
	const raw = queryIndex === -1 ? itemPath : itemPath.slice(0, queryIndex);
	const path = stripTrailingSlash(raw);
	const current = stripTrailingSlash(currentPath);
	return path === "/" ? current === "/" : current === path || current.startsWith(`${path}/`);
}

export type NavGroupKey = "top" | "content" | "manage" | "admin" | "plugins";

/** A navigation entry with its layout ID, `navPathId(resolveItemPath(item))`. */
export type NavLink = NavItem & { readonly id: string };

export interface NavGroup extends LayoutNavGroup<NavLink> {
	readonly key: NavGroupKey;
}

export interface NavBuildInput {
	manifest: SidebarNavProps["manifest"];
	pluginAdmins: PluginAdmins;
	role: number;
	/** Built-in labels go through `translate`; plugin labels only when `i18n` has a catalog entry. */
	i18n: Pick<I18n, "messages">;
	translate: I18n["_"];
	/** The current URL's `?locale=`, carried by taxonomy links but not by their IDs. */
	routeLocale?: string;
	commentBadge?: number;
}

function flatEntries(links: NavLink[]): NavEntry<NavLink>[] {
	return links.map((item) => ({ kind: "item", item }));
}

const NAV_GROUP_LABELS: Record<NavGroupKey, MessageDescriptor | null> = {
	top: null,
	content: msg`Content`,
	manage: msg`Manage`,
	admin: msg`Admin`,
	plugins: msg`Plugins`,
};

/**
 * Every navigation entry the user can see, before their personal layout: role
 * checks, `admin.hiddenNavItems`, hidden collections, and disabled plugins
 * applied, folders formed by `groupNavItems`. Groups come in display order and
 * empty ones are left out; Content exists only when a collection is visible.
 * Two entries with one ID link to the same page, so only the first is kept.
 */
export function buildNavGroups(input: NavBuildInput): NavGroup[] {
	const { manifest, pluginAdmins, role, translate, routeLocale } = input;

	const topItems: NavItem[] = [
		{ to: "/", label: translate(msg`Dashboard`), icon: ADMIN_NAV_ICONS.dashboard },
		{
			to: "/calendar",
			label: translate(msg`Calendar`),
			icon: ADMIN_NAV_ICONS.calendar,
			minRole: ROLE_CONTRIBUTOR,
			navId: "calendar",
		},
	];

	const collections = visibleCollectionEntries(manifest.collections);
	const contentItems: NavItem[] = [];
	for (const [name, config] of collections) {
		contentItems.push({
			to: "/content/$collection",
			label: config.label,
			icon: getCollectionNavIcon(name, config.icon),
			iconName: config.icon,
			group: config.group,
			groupRank: GROUP_RANK.collection,
			params: { collection: name },
		});
	}
	contentItems.push({
		to: "/media",
		label: translate(msg`Media`),
		icon: ADMIN_NAV_ICONS.media,
		navId: "media",
	});

	const collectionGroups = new Map(collections.map(([name, config]) => [name, config.group]));
	const contentGroups = new Set(
		Array.from(collectionGroups.values(), normalizeGroup).filter((group) => group !== undefined),
	);

	const manageItems: NavItem[] = [
		{
			to: "/comments",
			label: translate(msg`Comments`),
			icon: ADMIN_NAV_ICONS.comments,
			minRole: ROLE_EDITOR,
			badge: input.commentBadge,
			navId: "comments",
		},
		{
			to: "/menus",
			label: translate(msg`Menus`),
			icon: ADMIN_NAV_ICONS.menus,
			minRole: ROLE_EDITOR,
			navId: "menus",
		},
		{
			to: "/redirects",
			label: translate(msg`Redirects`),
			icon: ADMIN_NAV_ICONS.redirects,
			minRole: ROLE_ADMIN,
			navId: "redirects",
		},
		{
			to: "/widgets",
			label: translate(msg`Widgets`),
			icon: ADMIN_NAV_ICONS.widgets,
			minRole: ROLE_EDITOR,
			navId: "widgets",
		},
		{
			to: "/sections",
			label: translate(msg`Sections`),
			icon: ADMIN_NAV_ICONS.sections,
			minRole: ROLE_EDITOR,
			navId: "sections",
		},
		{
			to: "/bylines",
			label: translate(msg`Bylines`),
			icon: ADMIN_NAV_ICONS.bylines,
			minRole: ROLE_EDITOR,
			navId: "bylines",
		},
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
			label: translate(msg`Content Types`),
			icon: ADMIN_NAV_ICONS.contentTypes,
			minRole: ROLE_ADMIN,
		},
		{ ...BYLINE_SCHEMA_NAV_ITEM, label: translate(msg`Byline Schema`) },
		{ to: "/users", label: translate(msg`Users`), icon: Users, minRole: ROLE_ADMIN },
		{
			to: "/plugins-manager",
			label: translate(msg`Plugins`),
			icon: ADMIN_NAV_ICONS.plugins,
			minRole: ROLE_ADMIN,
		},
	];

	if (manifest.registry) {
		adminItems.push({
			to: "/plugins/registry",
			label: translate(msg`Registry`),
			icon: Storefront,
			minRole: ROLE_ADMIN,
		});
	}

	adminItems.push(
		{
			to: "/import/wordpress",
			label: translate(msg`Import`),
			icon: ADMIN_NAV_ICONS.import,
			minRole: ROLE_ADMIN,
			navId: "import",
		},
		{ to: "/settings", label: translate(msg`Settings`), icon: Gear, minRole: ROLE_ADMIN },
	);

	const translatePluginLabel = declaredLabelTranslator(input.i18n, (id) => translate(id));
	const pluginItems: NavItem[] = [];
	for (const [pluginId, config] of Object.entries(manifest.plugins)) {
		if (config.enabled === false) continue;
		if (config.adminPages && config.adminPages.length > 0) {
			const pluginPages = pluginAdmins[pluginId]?.pages;
			const isBlocksMode = config.adminMode === "blocks";
			for (const page of config.adminPages) {
				if (!isBlocksMode && !resolvePluginPagePath(pluginPages, page.path)) continue;
				if (!isSafePluginPagePath(page.path)) continue;
				const group = normalizeGroup(page.group);
				const item: NavItem = {
					to: `/plugins/${pluginId}${normalizePluginPagePath(page.path)}`,
					label: resolvePluginPageLabel(page.label, pluginId, translatePluginLabel),
					icon: resolveNavIcon(page.icon),
					iconName: page.icon,
					group,
					groupRank: GROUP_RANK.pluginPage,
				};
				(joinsContentFolder(group, contentGroups) ? contentItems : pluginItems).push(item);
			}
		}
	}

	const seenIds = new Set<string>();
	function visibleLinks(items: NavItem[]): NavLink[] {
		const links: NavLink[] = [];
		const shown = filterHiddenNavItems(
			filterNavItemsByRole(items, role),
			manifest.admin?.hiddenNavItems,
		);
		for (const item of shown) {
			const id = navPathId(resolveItemPath(item));
			if (seenIds.has(id)) continue;
			seenIds.add(id);
			links.push({ ...item, id });
		}
		return links;
	}
	const entriesByGroup: Array<[NavGroupKey, NavEntry<NavLink>[]]> = [
		["top", flatEntries(visibleLinks(topItems))],
		["content", collections.length > 0 ? groupNavItems(visibleLinks(contentItems)) : []],
		["manage", flatEntries(visibleLinks(manageItems))],
		["admin", flatEntries(visibleLinks(adminItems))],
		["plugins", groupNavItems(visibleLinks(pluginItems))],
	];
	return entriesByGroup
		.filter(([, entries]) => entries.length > 0)
		.map(([key, entries]) => {
			const label = NAV_GROUP_LABELS[key];
			return { key, label: label ? translate(label) : null, entries };
		});
}

/**
 * Admin sidebar navigation using kumo's Sidebar compound component.
 */
export function SidebarNav({ manifest }: SidebarNavProps) {
	const { t } = useLingui();
	// `_` is rebound on locale switches and catalog loads, so it invalidates the memo below.
	const { _: translate, i18n } = useLinguiContext();
	const location = useLocation();
	const currentPath = location.pathname;
	const routeLocale =
		new URL(location.href, "http://emdash.local").searchParams.get("locale") ?? undefined;
	const pluginAdmins = usePluginAdmins();
	const layout = useAdminLayout();

	const { data: user } = useCurrentUser();
	const role = user?.role ?? 0;

	// Fetch pending comment count for badge
	const { data: commentCounts } = useQuery({
		queryKey: ["commentCounts"],
		queryFn: fetchCommentCounts,
		staleTime: 60 * 1000,
		retry: false,
		enabled: role >= ROLE_EDITOR && !manifest.admin?.hiddenNavItems?.includes("comments"),
	});
	const commentBadge = commentCounts?.pending;

	const groups = React.useMemo(
		() =>
			resolveNav(
				buildNavGroups({
					manifest,
					pluginAdmins,
					role,
					i18n,
					translate,
					routeLocale,
					commentBadge,
				}),
				layout.nav,
			),
		[manifest, pluginAdmins, role, i18n, translate, routeLocale, commentBadge, layout.nav],
	);

	const folders = useFolderState();

	function renderNavEntries(entries: readonly NavEntry<NavLink>[]) {
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
				{groups.map((group) => (
					<KumoSidebar.Group
						key={group.key}
						className={group.key === "top" ? "mt-2 md:mt-1.5" : undefined}
					>
						{group.label && <KumoSidebar.GroupLabel>{group.label}</KumoSidebar.GroupLabel>}
						<KumoSidebar.Menu>{renderNavEntries(group.entries)}</KumoSidebar.Menu>
					</KumoSidebar.Group>
				))}
			</KumoSidebar.Content>

			<KumoSidebar.Footer className="gap-0">
				<KumoSidebar.Trigger className="rtl:rotate-180" />
				<div className="min-w-0 flex-1 overflow-hidden">
					<p
						data-testid="admin-version"
						className="w-40 overflow-hidden truncate ps-2 text-[11px] text-kumo-subtle"
					>
						{formatAdminVersion(manifest.version, manifest.commit, manifest.admin?.footerLabel)}
					</p>
				</div>
				<CustomizeSidebarLink />
			</KumoSidebar.Footer>
		</KumoSidebar>
	);
}

function CustomizeSidebarLink() {
	const { t } = useLingui();
	const { state, isMobile } = useSidebar();
	// The phone sheet always shows labels; `state` follows the desktop sidebar.
	if (state === "collapsed" && !isMobile) return null;
	const label = t`Customize sidebar`;
	return (
		<Tooltip
			content={label}
			side="top"
			// The trigger's own `cursor-default` would otherwise override the link's pointer.
			className="cursor-pointer"
			render={
				<RouterLinkButton
					to="/settings/sidebars"
					variant="ghost"
					shape="square"
					size="sm"
					aria-label={label}
					className="shrink-0 text-kumo-subtle"
					icon={<PencilSimple className="size-4" aria-hidden="true" />}
				/>
			}
		/>
	);
}
