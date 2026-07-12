import { Sidebar as KumoSidebar, useSidebar } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import { PuzzlePiece } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import * as React from "react";

import {
	buildAdminNavModel,
	isGroupCollapsed,
	NAV_COLLAPSE_STORAGE_KEY,
	parseNavCollapseState,
	ROLE_EDITOR,
	serializeNavCollapseState,
	toggleGroupCollapsed,
	type AdminNavGroup,
	type AdminNavItem,
	type AdminNavManifestInput,
	type NavCollapseState,
} from "../lib/admin-nav";
import { fetchCommentCounts } from "../lib/api/comments";
import { useCurrentUser } from "../lib/api/current-user";
import { usePluginAdmins } from "../lib/plugin-context";
import { BrandIcon } from "./Logo.js";

// Re-export for Shell.tsx and Header.tsx
export { KumoSidebar as Sidebar, useSidebar };

// The pure nav helpers moved to lib/admin-nav.ts (shared with the command
// palette); re-export from their old home so existing imports keep working.
export {
	BYLINE_SCHEMA_NAV_ITEM,
	filterNavItemsByRole,
	resolveNavIcon,
	toPhosphorIconName,
} from "../lib/admin-nav";

export interface SidebarNavProps {
	manifest: AdminNavManifestInput & {
		version?: string;
		commit?: string;
		admin?: {
			logo?: string;
			siteName?: string;
			favicon?: string;
		};
	};
}

/** Render-ready nav item: label resolved to a plain string. */
interface NavItem {
	to: string;
	label: string;
	icon: React.ElementType;
	params?: Record<string, string>;
	/** Optional badge count (e.g., pending comments) */
	badge?: number;
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
function resolveItemPath(item: Pick<NavItem, "to" | "params">): string {
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

function readStoredCollapseState(): NavCollapseState {
	try {
		return parseNavCollapseState(window.localStorage.getItem(NAV_COLLAPSE_STORAGE_KEY));
	} catch {
		return { collapsedGroupIds: [], expandedGroupIds: [] };
	}
}

/**
 * Admin sidebar navigation using kumo's Sidebar compound component.
 *
 * Renders the shared nav model (see lib/admin-nav.ts): default groups when
 * the site has no navigation config, the site's custom groups/order/hidden
 * items when it does. Group collapse is per-user, persisted in
 * localStorage — never in site config.
 */
export function SidebarNav({ manifest }: SidebarNavProps) {
	const { t } = useLingui();
	const location = useLocation();
	const currentPath = location.pathname;
	const pluginAdmins = usePluginAdmins();
	const { state: sidebarState } = useSidebar();

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

	const pendingComments = commentCounts?.pending;
	const model = React.useMemo(
		() => buildAdminNavModel(manifest, { userRole, pendingComments, pluginAdmins }),
		[manifest, userRole, pendingComments, pluginAdmins],
	);

	const [collapseState, setCollapseState] =
		React.useState<NavCollapseState>(readStoredCollapseState);

	const setGroupCollapsed = React.useCallback((groupId: string, collapsed: boolean) => {
		setCollapseState((prev) => {
			const next = toggleGroupCollapsed(prev, groupId, collapsed);
			try {
				window.localStorage.setItem(NAV_COLLAPSE_STORAGE_KEY, serializeNavCollapseState(next));
			} catch {
				// Storage unavailable (private mode) — collapse still works for the session.
			}
			return next;
		});
	}, []);

	function resolveLabel(label: string | MessageDescriptor): string {
		return typeof label === "string" ? label : t(label);
	}

	function renderItems(items: AdminNavItem[]) {
		return items.map((item) => {
			const navItem: NavItem = {
				to: item.to,
				label: resolveLabel(item.label),
				icon: item.icon,
				params: item.params,
				badge: item.badge,
			};
			const itemPath = resolveItemPath(navItem);
			return (
				<NavMenuLink key={item.id} item={navItem} isActive={isItemActive(itemPath, currentPath)} />
			);
		});
	}

	function renderGroup(group: AdminNavGroup, index: number) {
		// Preserve the classic top spacing on the leading (dashboard) block.
		const groupClassName = index === 0 ? "mt-2 md:mt-1.5" : undefined;
		const menu = <KumoSidebar.Menu>{renderItems(group.items)}</KumoSidebar.Menu>;

		// The icon-collapsed rail hides group headers and CollapsibleContent
		// suppresses its children there, so render plain groups in rail mode
		// — every item stays reachable as an icon, exactly the classic
		// behavior. Collapse state re-applies when the sidebar expands.
		if (!group.collapsible || group.label === undefined || sidebarState === "collapsed") {
			return (
				<KumoSidebar.Group key={group.id} className={groupClassName}>
					{group.label !== undefined && (
						<KumoSidebar.GroupLabel>{resolveLabel(group.label)}</KumoSidebar.GroupLabel>
					)}
					{menu}
				</KumoSidebar.Group>
			);
		}

		const open = !isGroupCollapsed(group, collapseState);
		const label = resolveLabel(group.label);

		return (
			<KumoSidebar.Group key={group.id} className={groupClassName}>
				<KumoSidebar.Collapsible
					open={open}
					onOpenChange={(next) => setGroupCollapsed(group.id, !next)}
				>
					<KumoSidebar.GroupLabel>
						<KumoSidebar.CollapsibleTrigger
							render={
								<button
									type="button"
									className="flex w-full items-center justify-between gap-1 text-start hover:text-kumo-default"
								>
									<span className="truncate">{label}</span>
									<KumoSidebar.MenuChevron className="shrink-0" />
								</button>
							}
						/>
					</KumoSidebar.GroupLabel>
					<KumoSidebar.CollapsibleContent>{menu}</KumoSidebar.CollapsibleContent>
				</KumoSidebar.Collapsible>
			</KumoSidebar.Group>
		);
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

			<KumoSidebar.Content>{model.groups.map(renderGroup)}</KumoSidebar.Content>

			<KumoSidebar.Footer>
				<p className="px-3 py-2 text-[11px] text-kumo-subtle group-data-[state=collapsed]/sidebar:hidden">
					{manifest.admin?.siteName || "EmDash CMS"} v{manifest.version || "0.0.0"}
					{manifest.commit && ` (${manifest.commit})`}
				</p>
			</KumoSidebar.Footer>
		</KumoSidebar>
	);
}
