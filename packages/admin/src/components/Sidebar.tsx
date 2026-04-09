import { Sidebar as KumoSidebar, Tooltip, useSidebar } from "@cloudflare/kumo";
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
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import * as React from "react";

import { NARROWSTACK_LOGO_DATA_URI } from "../assets/narrowstack-logo.js";
import { fetchCommentCounts } from "../lib/api/comments";
import { useCurrentUser } from "../lib/api/current-user";
import { usePluginAdmins } from "../lib/plugin-context";
import { cn } from "../lib/utils";

// Re-export for Shell.tsx and Header.tsx
export { KumoSidebar as Sidebar, useSidebar };

// Role levels (matching @emdash-cms/auth)
const ROLE_ADMIN = 50;
const ROLE_EDITOR = 40;

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
		version?: string;
		marketplace?: string;
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
 * Navigation item rendered as a TanStack Router <Link> inside kumo's
 * Sidebar.MenuItem. Styled to match kumo MenuButton appearance.
 * This approach guarantees client-side navigation works correctly.
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
			<span className="emdash-nav-label flex flex-1 items-center min-w-0 text-left overflow-hidden">
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

	const contentItems: NavItem[] = [{ to: "/", label: "Dashboard", icon: SquaresFour }];
	for (const [name, config] of Object.entries(manifest.collections)) {
		contentItems.push({
			to: "/content/$collection",
			label: config.label,
			icon: FileText,
			params: { collection: name },
		});
	}
	contentItems.push({ to: "/media", label: "Media", icon: Image });

	const manageItems: NavItem[] = [
		{
			to: "/comments",
			label: "Comments",
			icon: ChatCircle,
			minRole: ROLE_EDITOR,
			badge: commentCounts?.pending,
		},
		{ to: "/menus", label: "Menus", icon: List, minRole: ROLE_EDITOR },
		{ to: "/redirects", label: "Redirects", icon: ArrowsLeftRight, minRole: ROLE_ADMIN },
		{ to: "/widgets", label: "Widgets", icon: GridFour, minRole: ROLE_EDITOR },
		{ to: "/sections", label: "Sections", icon: Stack, minRole: ROLE_EDITOR },
		{
			to: "/taxonomies/$taxonomy",
			label: "Categories",
			icon: FileText,
			params: { taxonomy: "category" },
			minRole: ROLE_EDITOR,
		},
		{
			to: "/taxonomies/$taxonomy",
			label: "Tags",
			icon: FileText,
			params: { taxonomy: "tag" },
			minRole: ROLE_EDITOR,
		},
		{ to: "/bylines", label: "Bylines", icon: FileText, minRole: ROLE_EDITOR },
	];

	const adminItems: NavItem[] = [
		{ to: "/content-types", label: "Content Types", icon: Database, minRole: ROLE_ADMIN },
		{ to: "/users", label: "Users", icon: Users, minRole: ROLE_ADMIN },
		{ to: "/plugins-manager", label: "Plugins", icon: PuzzlePiece, minRole: ROLE_ADMIN },
	];

	if (manifest.marketplace) {
		adminItems.push(
			{ to: "/plugins/marketplace", label: "Marketplace", icon: Storefront, minRole: ROLE_ADMIN },
			{ to: "/themes/marketplace", label: "Themes", icon: Palette, minRole: ROLE_ADMIN },
		);
	}

	adminItems.push(
		{ to: "/import/wordpress", label: "Import", icon: Upload, minRole: ROLE_ADMIN },
		{ to: "/settings", label: "Settings", icon: Gear, minRole: ROLE_ADMIN },
	);

	const pluginItems: NavItem[] = [];
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
						.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
						.join(" ");
				pluginItems.push({ to: `/plugins/${pluginId}${page.path}`, label, icon: PuzzlePiece });
			}
		}
	}

	const filterByRole = (items: NavItem[]) =>
		items.filter((item) => !item.minRole || userRole >= item.minRole);

	const visibleContent = filterByRole(contentItems);
	const visibleManage = filterByRole(manageItems);
	const visibleAdmin = filterByRole(adminItems);
	const visiblePlugins = filterByRole(pluginItems);

	function renderNavItems(items: NavItem[]) {
		return items.map((item, index) => {
			const itemPath = resolveItemPath(item);
			const active = isItemActive(itemPath, currentPath);
			return <NavMenuLink key={`${item.to}-${index}`} item={item} isActive={active} />;
		});
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
		`,
				}}
			/>
			<KumoSidebar className="emdash-sidebar" aria-label="Admin navigation">
				<KumoSidebar.Header>
					<Link
						to="/"
						className="emdash-brand-link flex w-full min-w-0 items-center gap-2 px-3 py-1"
					>
						<img
							src={NARROWSTACK_LOGO_DATA_URI}
							className="size-5 shrink-0 rounded-sm"
							aria-hidden="true"
							alt=""
						/>
						<span className="emdash-brand-text font-semibold truncate">narrowstack.</span>
					</Link>
				</KumoSidebar.Header>

				<KumoSidebar.Content>
					{/* Dashboard — standalone */}
					<KumoSidebar.Group>
						<KumoSidebar.Menu>
							<NavMenuLink
								item={{ to: "/", label: "Dashboard", icon: SquaresFour }}
								isActive={isItemActive("/", currentPath)}
							/>
						</KumoSidebar.Menu>
					</KumoSidebar.Group>

					<KumoSidebar.Separator />

					{/* Content — collections + media (collapsible) */}
					{visibleContent.length > 1 && (
						<KumoSidebar.Group collapsible defaultOpen>
							<KumoSidebar.GroupLabel>Content</KumoSidebar.GroupLabel>
							<KumoSidebar.GroupContent>
								<KumoSidebar.Menu>
									{renderNavItems(visibleContent.filter((i) => i.to !== "/"))}
								</KumoSidebar.Menu>
							</KumoSidebar.GroupContent>
						</KumoSidebar.Group>
					)}

					<KumoSidebar.Separator />

					{/* Manage — comments, menus, taxonomies, etc. (collapsible) */}
					{visibleManage.length > 0 && (
						<KumoSidebar.Group collapsible defaultOpen>
							<KumoSidebar.GroupLabel>Manage</KumoSidebar.GroupLabel>
							<KumoSidebar.GroupContent>
								<KumoSidebar.Menu>{renderNavItems(visibleManage)}</KumoSidebar.Menu>
							</KumoSidebar.GroupContent>
						</KumoSidebar.Group>
					)}

					<KumoSidebar.Separator />

					{/* Admin — content types, users, plugins, import (collapsible) */}
					{visibleAdmin.length > 0 && (
						<KumoSidebar.Group collapsible defaultOpen>
							<KumoSidebar.GroupLabel>Admin</KumoSidebar.GroupLabel>
							<KumoSidebar.GroupContent>
								<KumoSidebar.Menu>{renderNavItems(visibleAdmin)}</KumoSidebar.Menu>
							</KumoSidebar.GroupContent>
						</KumoSidebar.Group>
					)}

					{/* Plugin pages (collapsible) */}
					{visiblePlugins.length > 0 && (
						<>
							<KumoSidebar.Separator />
							<KumoSidebar.Group collapsible defaultOpen>
								<KumoSidebar.GroupLabel>Plugins</KumoSidebar.GroupLabel>
								<KumoSidebar.GroupContent>
									<KumoSidebar.Menu>{renderNavItems(visiblePlugins)}</KumoSidebar.Menu>
								</KumoSidebar.GroupContent>
							</KumoSidebar.Group>
						</>
					)}
				</KumoSidebar.Content>

				<KumoSidebar.Footer>
					<p className="emdash-nav-label px-3 py-2 text-[11px] text-white/30">
						EmDash CMS v{manifest.version || "0.0.0"}
					</p>
				</KumoSidebar.Footer>
			</KumoSidebar>
		</>
	);
}
