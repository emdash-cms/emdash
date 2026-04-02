import { Button, LinkButton, Popover } from "@cloudflare/kumo";
import {
	SignOut,
	Shield,
	Gear,
	ArrowSquareOut,
	ArrowsClockwise,
	WifiSlash,
	CheckCircle,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import { apiFetch } from "../lib/api/client";
import { useCurrentUser } from "../lib/api/current-user";
import { useSyncStatus, useCacheActions } from "../lib/cache/cache-context.js";
import type { SyncStatus } from "../lib/cache/sync.js";
import { Sidebar } from "./Sidebar";
import { ThemeToggle } from "./ThemeToggle";

export type { CurrentUser } from "../lib/api/current-user";

async function handleLogout() {
	const res = await apiFetch("/_emdash/api/auth/logout?redirect=/_emdash/admin/login", {
		method: "POST",
		credentials: "same-origin",
	});
	if (res.redirected) {
		window.location.href = res.url;
	} else {
		window.location.href = "/_emdash/admin/login";
	}
}

const SYNC_CONFIG: Record<
	SyncStatus,
	{ icon: React.ElementType; label: string; className: string }
> = {
	idle: { icon: CheckCircle, label: "Up to date", className: "text-kumo-subtle" },
	syncing: {
		icon: ArrowsClockwise,
		label: "Syncing...",
		className: "text-kumo-subtle animate-spin",
	},
	synced: { icon: CheckCircle, label: "Synced", className: "text-kumo-success" },
	offline: { icon: WifiSlash, label: "Offline", className: "text-kumo-warning" },
	error: {
		icon: ArrowsClockwise,
		label: "Sync error — click to retry",
		className: "text-kumo-danger",
	},
};

function SyncIndicator() {
	const syncStatus = useSyncStatus();
	const { syncNow } = useCacheActions();

	const config = SYNC_CONFIG[syncStatus];
	const Icon = config.icon;

	// Only show when actively syncing, offline, or errored
	if (syncStatus === "idle" || syncStatus === "synced") {
		return null;
	}

	return (
		<Button variant="ghost" size="sm" onClick={syncNow} title={config.label} className="gap-1">
			<Icon className={`h-4 w-4 ${config.className}`} />
			<span className="hidden sm:inline text-xs">{config.label}</span>
		</Button>
	);
}

/**
 * Admin header with mobile menu toggle and user actions.
 * Uses useSidebar() hook from kumo Sidebar.Provider context.
 */
export function Header() {
	const [userMenuOpen, setUserMenuOpen] = React.useState(false);

	const { data: user } = useCurrentUser();

	// Get display name and initials
	const displayName = user?.name || user?.email || "User";
	const initialsSource = user?.name || user?.email || "U";
	const initials = (initialsSource[0] ?? "U").toUpperCase();

	return (
		<header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b bg-kumo-base px-4">
			{/* Sidebar toggle — collapses to icon mode on desktop, opens drawer on mobile */}
			<Sidebar.Trigger />

			{/* Right side actions */}
			<div className="flex items-center space-x-2">
				{/* View site link */}
				<LinkButton variant="ghost" size="sm" href="/" external>
					<ArrowSquareOut className="h-4 w-4 mr-1" />
					View Site
				</LinkButton>

				{/* Theme toggle */}
				<ThemeToggle />

				{/* Sync status indicator */}
				<SyncIndicator />

				{/* User menu */}
				<Popover open={userMenuOpen} onOpenChange={setUserMenuOpen}>
					<Popover.Trigger asChild>
						<Button variant="ghost" size="sm" className="gap-2">
							{user?.avatarUrl ? (
								<img src={user.avatarUrl} alt="" className="h-6 w-6 rounded-full object-cover" />
							) : (
								<div className="h-6 w-6 rounded-full bg-kumo-brand/10 flex items-center justify-center text-xs font-medium">
									{initials}
								</div>
							)}
							<span className="hidden sm:inline max-w-[120px] truncate">{displayName}</span>
						</Button>
					</Popover.Trigger>

					<Popover.Content className="w-56 p-2" align="end">
						{/* User info */}
						<div className="px-3 py-2 border-b mb-1">
							<div className="font-medium truncate">{user?.name || "User"}</div>
							<div className="text-xs text-kumo-subtle truncate">{user?.email}</div>
						</div>
						<div className="grid gap-1">
							<Link
								to="/settings/security"
								onClick={() => setUserMenuOpen(false)}
								className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-kumo-tint"
							>
								<Shield className="h-4 w-4" />
								Security Settings
							</Link>
							<Link
								to="/settings"
								onClick={() => setUserMenuOpen(false)}
								className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-kumo-tint"
							>
								<Gear className="h-4 w-4" />
								Settings
							</Link>
							<hr className="my-1" />
							<button
								onClick={handleLogout}
								className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-kumo-danger hover:bg-kumo-danger/10 w-full text-left"
							>
								<SignOut className="h-4 w-4" />
								Log out
							</button>
						</div>
					</Popover.Content>
				</Popover>
			</div>
		</header>
	);
}
