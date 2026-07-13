import { Sidebar as KumoSidebar, useSidebar } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { ClockCounterClockwise, ShieldCheck, SquaresFour } from "@phosphor-icons/react";
import { useLocation } from "@tanstack/react-router";
import * as React from "react";

// Re-exported so Shell.tsx and Header.tsx share one import path, mirroring
// packages/admin's Sidebar.tsx.
export { KumoSidebar as Sidebar, useSidebar };

interface NavItem {
	to: string;
	label: string;
	icon: React.ElementType;
}

/** Kumo's LinkProvider (wired up in App.tsx) maps `href` to a TanStack
 * Router Link, so this renders through client-side navigation. */
function NavMenuLink({ item, isActive }: { item: NavItem; isActive: boolean }) {
	const { state } = useSidebar();
	return (
		<KumoSidebar.MenuButton
			href={item.to}
			active={isActive}
			tooltip={state === "collapsed" ? item.label : undefined}
			icon={item.icon}
		>
			{item.label}
		</KumoSidebar.MenuButton>
	);
}

/** Checks if a nav item is active based on the current router path. */
function isItemActive(itemPath: string, currentPath: string): boolean {
	return itemPath === "/"
		? currentPath === "/"
		: currentPath === itemPath || currentPath.startsWith(`${itemPath}/`);
}

export function SidebarNav() {
	const { t } = useLingui();
	const currentPath = useLocation({ select: (location) => location.pathname });

	const items: NavItem[] = [
		{ to: "/", label: t`Dashboard`, icon: SquaresFour },
		{ to: "/assessments", label: t`Assessments`, icon: ShieldCheck },
		{ to: "/audit", label: t`Audit log`, icon: ClockCounterClockwise },
	];

	return (
		<KumoSidebar aria-label={t`Labeler console navigation`}>
			<KumoSidebar.Header>
				<span className="truncate px-3 py-1 font-semibold group-data-[state=collapsed]/sidebar:hidden">
					{t`Labeler console`}
				</span>
			</KumoSidebar.Header>
			<KumoSidebar.Content>
				<KumoSidebar.Group>
					<KumoSidebar.Menu>
						{items.map((item) => (
							<NavMenuLink
								key={item.to}
								item={item}
								isActive={isItemActive(item.to, currentPath)}
							/>
						))}
					</KumoSidebar.Menu>
				</KumoSidebar.Group>
			</KumoSidebar.Content>
		</KumoSidebar>
	);
}
