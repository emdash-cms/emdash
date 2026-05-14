import { Sidebar as KumoSidebar, Tooltip, useSidebar } from "@cloudflare/kumo";
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
	ChartPie,
	Rocket,
	Globe,
	MagnifyingGlass,
	ShieldCheck,
	PenNib,
	Calendar,
	Envelope,
	Phone,
	MapPin,
	Star,
	Tag,
	Book,
	GraduationCap,
	Wrench,
	Lightbulb,
	CaretRight,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import * as React from "react";

import { fetchCommentCounts } from "../lib/api/comments";
import { useCurrentUser } from "../lib/api/current-user";
import { usePluginAdmins } from "../lib/plugin-context";
import { cn } from "../lib/utils";
import { BrandIcon } from "./Logo.js";

// Re-export for Shell.tsx and Header.tsx
export { KumoSidebar as Sidebar, useSidebar };

// Role levels (matching @emdash-cms/auth)
const ROLE_ADMIN = 50;
const ROLE_EDITOR = 40;

/** Map of icon names to Phosphor icon components for plugin pages and collections. */
const ICON_MAP: Record<string, React.ElementType> = {
	gear: Gear,
	chart: ChartBar,
	"chart-pie": ChartPie,
	rocket: Rocket,
	globe: Globe,
	database: Database,
	list: List,
	search: MagnifyingGlass,
	shield: ShieldCheck,
	puzzle: PuzzlePiece,
	pen: PenNib,
	calendar: Calendar,
	mail: Envelope,
	phone: Phone,
	map: MapPin,
	star: Star,
	tag: Tag,
	book: Book,
	graduation: GraduationCap,
	wrench: Wrench,
	lightbulb: Lightbulb,
	upload: Upload,
	grid: GridFour,
	users: Users,
	palette: Palette,
	storefront: Storefront,
	arrows: ArrowsLeftRight,
	file: FileText,
	image: Image,
	chat: ChatCircle,
};

/** Resolve a Phosphor icon component by name, falling back to the default. */
function resolveIcon(name: string | undefined, fallback: React.ElementType): React.ElementType {
	if (!name) return fallback;
	return ICON_MAP[name] ?? fallback;
}

export interface SidebarNavProps {
	manifest: {
		collections: Record<
			string,
			{
				label: string;
				sortOrder?: number;
				group?: string;
				icon?: string;
			}
		>;
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
					sortOrder?: number;
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
		admin?: {
			logo?: string;
			siteName?: string;
			favicon?: string;
		};
		sidebar?: {
			hideCoreFeatures?: string[];
			hideCollections?: string[];
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
	/** Child items for nested submenu (max 1 level) */
	children?: NavItem[];
}

interface NavGroup {
	label: string;
	items: NavItem[];
	/** Sort order for the group itself (lower = earlier) */
	sortOrder?: number;
}

/** Regex to strip leading slash from a path */
const LEADING_SLASH_PATTERN = /^\//;

/**
 * Navigation item rendered as a TanStack Router <Link> inside kumo's
 * Sidebar.MenuItem. Styled to match kumo MenuButton appearance.
 */
function NavMenuLink({ item, isActive }: { item: NavItem; isActive: boolean }) {
	const { state } = useSidebar();
	const Icon = item.icon;

	const link = (
		<Link
			// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- TanStack Router requires literal route types
			to={item.to as "/"}
			params={item.params}
			aria-current={isActive ? "page" : undefined}
			data-active={isActive || undefined}
			data-sidebar="menu-button"
			className={cn(
				"emdash-nav-link group/menu-button flex w-full min-w-0 items-center gap-2.5 rounded-md no-underline outline-none cursor-pointer",
				"min-h-[36px] px-3 py-1.5 text-[13px]",
				"transition-all duration-200 ease-out",
				isActive ? "bg-kumo-brand text-white" : "text-white/70 hover:text-white hover:bg-white/8",
				"focus-visible:ring-2 focus-visible:ring-kumo-brand/50",
			)}
		>
			<Icon
				className={cn(
					"emdash-nav-icon size-[18px] shrink-0 transition-colors duration-200",
					isActive ? "text-white" : "text-white/60 group-hover/menu-button:text-white/90",
				)}
				aria-hidden="true"
			/>
			<span className="emdash-nav-label flex flex-1 items-center min-w-0 text-start overflow-hidden">
				{item.label}
				{item.badge != null && item.badge > 0 && (
					<KumoSidebar.MenuBadge>{item.badge}</KumoSidebar.MenuBadge>
				)}
			</span>
		</Link>
	);

	return (
		<KumoSidebar.MenuItem>
			{state === "collapsed" ? (
				<Tooltip content={item.label} side="right" asChild>
					{link}
				</Tooltip>
			) : (
				link
			)}
		</KumoSidebar.MenuItem>
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

/**
 * Expandable nav item with children (submenu).
 * The parent item is not navigable — clicking toggles the children.
 */
function NavSubMenu({ item, currentPath }: { item: NavItem; currentPath: string }) {
	const { state } = useSidebar();
	const [expanded, setExpanded] = React.useState(false);
	const Icon = item.icon;

	const hasActiveChild =
		item.children?.some((child) => {
			const childPath = resolveItemPath(child);
			return isItemActive(childPath, currentPath);
		}) ?? false;

	React.useEffect(() => {
		if (hasActiveChild) setExpanded(true);
	}, [hasActiveChild]);

	return (
		<KumoSidebar.MenuItem>
			<button
				type="button"
				onClick={() => setExpanded((v) => !v)}
				aria-expanded={expanded}
				data-sidebar="menu-button"
				className={cn(
					"emdash-nav-link group/menu-button flex w-full min-w-0 items-center gap-2.5 rounded-md outline-none cursor-pointer",
					"min-h-[36px] px-3 py-1.5 text-[13px]",
					"transition-all duration-200 ease-out",
					"text-white/70 hover:text-white hover:bg-white/8",
					"focus-visible:ring-2 focus-visible:ring-kumo-brand/50",
				)}
			>
				<Icon
					className={cn(
						"emdash-nav-icon size-[18px] shrink-0 transition-colors duration-200",
						"text-white/60 group-hover/menu-button:text-white/90",
					)}
					aria-hidden="true"
				/>
				<span className="emdash-nav-label flex flex-1 items-center min-w-0 text-start overflow-hidden">
					{item.label}
				</span>
				<CaretRight
					className={cn(
						"size-3 shrink-0 transition-transform duration-200 text-white/40",
						expanded && "rotate-90",
						"rtl:-scale-x-100",
					)}
					aria-hidden="true"
				/>
			</button>
			{expanded && item.children && (
				<div className="ms-4 border-s border-white/10 ps-2 mt-1 space-y-0.5">
					{item.children.map((child, idx) => {
						const childPath = resolveItemPath(child);
						const childActive = isItemActive(childPath, currentPath);
						return (
							<KumoSidebar.MenuItem key={`${child.to}-${idx}`}>
								{state === "collapsed" ? (
									<Tooltip content={child.label} side="right" asChild>
										<NavMenuLink item={child} isActive={childActive} />
									</Tooltip>
								) : (
									<NavMenuLink item={child} isActive={childActive} />
								)}
							</KumoSidebar.MenuItem>
						);
					})}
				</div>
			)}
		</KumoSidebar.MenuItem>
	);
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

	const dashboardItem: NavItem = { to: "/", label: t`Dashboard`, icon: SquaresFour };

	// Sidebar config for hiding items
	const hideCollections = new Set(manifest.sidebar?.hideCollections ?? []);
	const hideCoreFeatures = new Set(manifest.sidebar?.hideCoreFeatures ?? []);

	// Map of core feature slugs to their nav item "to" paths for hiding
	const CORE_FEATURE_PATHS: Record<string, string> = {
		comments: "/comments",
		menus: "/menus",
		redirects: "/redirects",
		widgets: "/widgets",
		sections: "/sections",
		bylines: "/bylines",
		"content-types": "/content-types",
		users: "/users",
		"plugins-manager": "/plugins-manager",
		import: "/import/wordpress",
		settings: "/settings",
	};

	// Group collections by their `group` field
	const collectionGroups = new Map<string, NavItem[]>();
	for (const [name, config] of Object.entries(manifest.collections)) {
		if (hideCollections.has(name)) continue;
		const groupName = config.group || "";
		const items = collectionGroups.get(groupName) ?? [];
		items.push({
			to: "/content/$collection",
			label: config.label,
			icon: resolveIcon(config.icon, FileText),
			params: { collection: name },
		});
		collectionGroups.set(groupName, items);
	}
	// Sort items within each group by sortOrder (from the manifest)
	for (const [, items] of collectionGroups) {
		items.sort((a, b) => {
			const aOrder = manifest.collections[a.params?.collection ?? ""]?.sortOrder ?? 0;
			const bOrder = manifest.collections[b.params?.collection ?? ""]?.sortOrder ?? 0;
			return aOrder - bOrder || a.label.localeCompare(b.label);
		});
	}

	// Build content groups: ungrouped collections + Media go into "Content",
	// named groups become their own collapsible sections
	const ungroupedCollections = collectionGroups.get("") ?? [];
	const namedCollectionGroups = [...collectionGroups.entries()]
		.filter(([group]) => group !== "")
		.map(
			([group, items]): NavGroup => ({
				label: group,
				items: [...items, { to: "/media", label: t`Media`, icon: Image }],
			}),
		);

	const contentItems: NavItem[] = [
		...ungroupedCollections,
		{ to: "/media", label: t`Media`, icon: Image },
	];

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
	].filter((item) => !hideCoreFeatures.has(item.to.replace(LEADING_SLASH_PATTERN, "")));

	const adminItems: NavItem[] = [
		{ to: "/content-types", label: t`Content Types`, icon: Database, minRole: ROLE_ADMIN },
		{ to: "/users", label: t`Users`, icon: Users, minRole: ROLE_ADMIN },
		{ to: "/plugins-manager", label: t`Plugins`, icon: PuzzlePiece, minRole: ROLE_ADMIN },
	];

	if (manifest.marketplace) {
		adminItems.push(
			{
				to: "/plugins/marketplace",
				label: t`Marketplace`,
				icon: Storefront,
				minRole: ROLE_ADMIN,
			},
			{ to: "/themes/marketplace", label: t`Themes`, icon: Palette, minRole: ROLE_ADMIN },
		);
	}

	adminItems.push(
		{ to: "/import/wordpress", label: t`Import`, icon: Upload, minRole: ROLE_ADMIN },
		{ to: "/settings", label: t`Settings`, icon: Gear, minRole: ROLE_ADMIN },
	);

	// Filter admin items by hideCoreFeatures
	const filteredAdminItems = adminItems.filter((item) => {
		// Map the item's path to a core feature slug
		for (const [feature, path] of Object.entries(CORE_FEATURE_PATHS)) {
			if (item.to === path && hideCoreFeatures.has(feature)) return false;
		}
		return true;
	});

	// Group plugin pages by their `group` field
	const pluginGroupItems = new Map<string, { item: NavItem; sortOrder: number }[]>();
	for (const [pluginId, config] of Object.entries(manifest.plugins)) {
		if (config.enabled === false) continue;
		if (config.adminPages && config.adminPages.length > 0) {
			const pluginPages = pluginAdmins[pluginId]?.pages;
			const isBlocksMode = config.adminMode === "blocks";
			for (const page of config.adminPages) {
				if (!isBlocksMode && !pluginPages?.[page.path]) continue;
				const label =
					page.label ||
					pluginId
						.split("-")
						.map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
						.join(" ");
				const groupName = page.group || "";
				const entries = pluginGroupItems.get(groupName) ?? [];
				entries.push({
					item: {
						to: `/plugins/${pluginId}${page.path}`,
						label,
						icon: resolveIcon(page.icon, PuzzlePiece),
					},
					sortOrder: page.sortOrder ?? 0,
				});
				pluginGroupItems.set(groupName, entries);
			}
		}
	}
	// Sort items within each plugin group by sortOrder, then label
	for (const [, entries] of pluginGroupItems) {
		entries.sort((a, b) => a.sortOrder - b.sortOrder || a.item.label.localeCompare(b.item.label));
	}

	const ungroupedPlugins = (pluginGroupItems.get("") ?? []).map((e) => e.item);
	const namedPluginGroups = [...pluginGroupItems.entries()]
		.filter(([group]) => group !== "")
		.map(([group, entries]): NavGroup => ({ label: group, items: entries.map((e) => e.item) }));

	const filterByRole = (items: NavItem[]) =>
		items.filter((item) => !item.minRole || userRole >= item.minRole);

	const visibleContent = filterByRole(contentItems);
	const visibleManage = filterByRole(manageItems);
	const visibleAdmin = filterByRole(filteredAdminItems);
	const visibleUngroupedPlugins = filterByRole(ungroupedPlugins);
	const visibleNamedPluginGroups = namedPluginGroups
		.map((group): NavGroup => ({ ...group, items: filterByRole(group.items) }))
		.filter((group) => group.items.length > 0);

	function renderNavItems(items: NavItem[]) {
		return items.map((item, index) => {
			if (item.children && item.children.length > 0) {
				return <NavSubMenu key={`${item.to}-${index}`} item={item} currentPath={currentPath} />;
			}
			const itemPath = resolveItemPath(item);
			const active = isItemActive(itemPath, currentPath);
			return <NavMenuLink key={`${item.to}-${index}`} item={item} isActive={active} />;
		});
	}

	function renderGroup(group: NavGroup, defaultOpen = true) {
		return (
			<KumoSidebar.Group key={group.label} collapsible defaultOpen={defaultOpen}>
				<KumoSidebar.GroupLabel className="[&>span]:text-start [&_svg]:rtl:-scale-x-100 [&_svg]:rtl:-scale-y-100">
					{group.label}
				</KumoSidebar.GroupLabel>
				<KumoSidebar.GroupContent>
					<KumoSidebar.Menu>{renderNavItems(group.items)}</KumoSidebar.Menu>
				</KumoSidebar.GroupContent>
			</KumoSidebar.Group>
		);
	}

	return (
		<>
			{/* Injected styles — Tailwind 4 strips [data-sidebar] attribute selectors from CSS files.
			    All sidebar-specific overrides go here to avoid conflicting with kumo's inline styles. */}
			<style
				dangerouslySetInnerHTML={{
					__html: `
			/* Classic dark chrome — override kumo tokens within the sidebar */
			.emdash-sidebar {
				--color-kumo-base: #1d2327;
				--color-kumo-tint: rgba(255,255,255,0.1);
				--color-kumo-line: rgba(255,255,255,0.08);
				--color-kumo-brand: #2271b1;
				--text-color-kumo-default: #fff;
				--text-color-kumo-subtle: rgba(255,255,255,0.7);
				--text-color-kumo-strong: #fff;
				background-color: #1d2327 !important;
				color: #fff !important;
				border-color: rgba(255,255,255,0.08) !important;
			}
			/* Group labels — uppercase muted style */
			.emdash-sidebar [data-sidebar="group-label"] {
				color: rgba(255,255,255,0.45) !important;
				font-size: 11px !important;
				text-transform: uppercase;
				letter-spacing: 0.06em;
				font-weight: 600;
				padding-left: 0.75rem;
				padding-right: 0.75rem;
			}
			.emdash-sidebar [data-sidebar="group-label"] svg {
				color: rgba(255,255,255,0.3);
			}
			.emdash-sidebar [data-sidebar="group-label"]:hover svg {
				color: rgba(255,255,255,0.6);
			}
			/* Separators */
			.emdash-sidebar [data-sidebar="separator"] {
				border-color: rgba(255,255,255,0.06) !important;
				margin: 0.5rem 0.75rem;
			}
			/* Header/footer borders */
			.emdash-sidebar [data-sidebar="header"] {
				border-bottom: 1px solid rgba(255,255,255,0.08);
			}
			.emdash-sidebar [data-sidebar="footer"] {
				border-top: 1px solid rgba(255,255,255,0.08);
			}

			/* Keep all nav icons visible when sidebar collapses to icon mode */
			.emdash-sidebar[data-state="collapsed"] [data-sidebar="group-content"] {
				grid-template-rows: 1fr !important;
			}
			/* Mobile drawer: kumo's Sheet has no data-state attribute, so group-content
			   stays at grid-rows-[0fr] (hidden). Force it open in the mobile sidebar. */
			.emdash-sidebar[data-mobile="true"] [data-sidebar="group-content"] {
				grid-template-rows: 1fr !important;
			}
			/* Collapsed separators — thin centered line */
			.emdash-sidebar[data-state="collapsed"] [data-sidebar="separator"] {
				margin: 0.375rem 0.625rem;
			}
			/* Collapsed: tighten group spacing */
			.emdash-sidebar[data-state="collapsed"] [data-sidebar="group"] {
				gap: 0.125rem;
			}
			.emdash-sidebar[data-state="collapsed"] [data-sidebar="menu"] {
				gap: 0.125rem;
			}

			/* Collapsed: nav links — center icon, hide text */
			.emdash-sidebar[data-state="collapsed"] .emdash-nav-link {
				justify-content: center;
				padding: 0.5rem 0;
				gap: 0;
				min-height: 36px;
			}
			.emdash-sidebar[data-state="collapsed"] .emdash-nav-label {
				display: none !important;
			}
			/* Collapsed: brand link */
			.emdash-sidebar[data-state="collapsed"] .emdash-brand-link {
				justify-content: center;
				padding-left: 0;
				padding-right: 0;
			}
			.emdash-sidebar[data-state="collapsed"] .emdash-brand-text {
				display: none !important;
			}

			/* Mobile drawer slide animation from left (LTR) */
			[data-starting-style]:has(> .emdash-sidebar[data-mobile="true"]),
			[data-ending-style]:has(> .emdash-sidebar[data-mobile="true"]) {
				transform: translateX(-100%);
			}

			/* Mobile drawer slide animation from right (RTL) */
			[dir="rtl"] [data-starting-style]:has(> .emdash-sidebar[data-mobile="true"]),
			[dir="rtl"] [data-ending-style]:has(> .emdash-sidebar[data-mobile="true"]) {
				transform: translateX(100%);
				--tw-translate-x: 100%;
			}

			/* RTL: Position drawer on right side */
			[dir="rtl"] :has(> .emdash-sidebar[data-mobile="true"]) {
				left: auto;
				right: 0;
			}
		`,
				}}
			/>
			<KumoSidebar className="emdash-sidebar" aria-label={t`Admin navigation`}>
				<KumoSidebar.Header>
					<Link
						to="/"
						className="emdash-brand-link flex w-full min-w-0 items-center gap-2 px-3 py-1"
					>
						<BrandIcon
							logoUrl={manifest.admin?.logo}
							siteName={manifest.admin?.siteName}
							className="size-5 shrink-0"
							aria-hidden="true"
						/>
						<span className="emdash-brand-text font-semibold truncate">
							{manifest.admin?.siteName || "EmDash"}
						</span>
					</Link>
				</KumoSidebar.Header>

				<KumoSidebar.Content>
					{/* Dashboard — standalone */}
					<KumoSidebar.Group>
						<KumoSidebar.Menu>
							<NavMenuLink item={dashboardItem} isActive={isItemActive("/", currentPath)} />
						</KumoSidebar.Menu>
					</KumoSidebar.Group>

					<KumoSidebar.Separator />

					{/* Content — ungrouped collections + media (collapsible) */}
					{visibleContent.length > 0 && (
						<KumoSidebar.Group collapsible defaultOpen>
							<KumoSidebar.GroupLabel className="[&>span]:text-start [&_svg]:rtl:-scale-x-100 [&_svg]:rtl:-scale-y-100">{t`Content`}</KumoSidebar.GroupLabel>
							<KumoSidebar.GroupContent>
								<KumoSidebar.Menu>{renderNavItems(visibleContent)}</KumoSidebar.Menu>
							</KumoSidebar.GroupContent>
						</KumoSidebar.Group>
					)}

					{/* Named collection groups (e.g., "Blog", "Shop") */}
					{namedCollectionGroups.map((group) => (
						<React.Fragment key={group.label}>
							<KumoSidebar.Separator />
							{renderGroup(group)}
						</React.Fragment>
					))}

					<KumoSidebar.Separator />

					{/* Manage — comments, menus, taxonomies, etc. (collapsible) */}
					{visibleManage.length > 0 && (
						<KumoSidebar.Group collapsible defaultOpen>
							<KumoSidebar.GroupLabel className="[&>span]:text-start [&_svg]:rtl:-scale-x-100 [&_svg]:rtl:-scale-y-100">{t`Manage`}</KumoSidebar.GroupLabel>
							<KumoSidebar.GroupContent>
								<KumoSidebar.Menu>{renderNavItems(visibleManage)}</KumoSidebar.Menu>
							</KumoSidebar.GroupContent>
						</KumoSidebar.Group>
					)}

					<KumoSidebar.Separator />

					{/* Admin — content types, users, plugins, import (collapsible) */}
					{visibleAdmin.length > 0 && (
						<KumoSidebar.Group collapsible defaultOpen>
							<KumoSidebar.GroupLabel className="[&>span]:text-start [&_svg]:rtl:-scale-x-100 [&_svg]:rtl:-scale-y-100">{t`Admin`}</KumoSidebar.GroupLabel>
							<KumoSidebar.GroupContent>
								<KumoSidebar.Menu>{renderNavItems(visibleAdmin)}</KumoSidebar.Menu>
							</KumoSidebar.GroupContent>
						</KumoSidebar.Group>
					)}

					{/* Named plugin groups (e.g., "SEO", "Analytics") */}
					{visibleNamedPluginGroups.length > 0 && (
						<>
							<KumoSidebar.Separator />
							{visibleNamedPluginGroups.map((group) => renderGroup(group))}
						</>
					)}

					{/* Ungrouped plugin pages (collapsible) */}
					{visibleUngroupedPlugins.length > 0 && (
						<>
							<KumoSidebar.Separator />
							<KumoSidebar.Group collapsible defaultOpen>
								<KumoSidebar.GroupLabel className="[&>span]:text-start [&_svg]:rtl:-scale-x-100 [&_svg]:rtl:-scale-y-100">{t`Plugins`}</KumoSidebar.GroupLabel>
								<KumoSidebar.GroupContent>
									<KumoSidebar.Menu>{renderNavItems(visibleUngroupedPlugins)}</KumoSidebar.Menu>
								</KumoSidebar.GroupContent>
							</KumoSidebar.Group>
						</>
					)}
				</KumoSidebar.Content>

				<KumoSidebar.Footer>
					<p className="emdash-nav-label px-3 py-2 text-[11px] text-white/30">
						{manifest.admin?.siteName || "EmDash CMS"} v{manifest.version || "0.0.0"}
						{manifest.commit && ` (${manifest.commit})`}
					</p>
				</KumoSidebar.Footer>
			</KumoSidebar>
		</>
	);
}
