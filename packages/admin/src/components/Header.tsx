import { Button, LinkButton, Popover } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { SignOut, Shield, Gear, ArrowSquareOut } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import { apiFetch } from "../lib/api/client";
import { useCurrentUser } from "../lib/api/current-user";
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

/**
 * Admin header with mobile menu toggle and user actions.
 * Uses useSidebar() hook from kumo Sidebar.Provider context.
 */
export function Header() {
	const { t } = useLingui();
	const [userMenuOpen, setUserMenuOpen] = React.useState(false);

	const { data: user } = useCurrentUser();

	// Get display name and initials
	const displayName = user?.name || user?.email || t`User`;
	const initialsSource = user?.name || user?.email || "U";
	const initials = (initialsSource[0] ?? "U").toUpperCase();

	return (
		<header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b bg-kumo-base px-4">
			{/* Sidebar toggle — collapses to icon mode on desktop, opens drawer on mobile */}
			<Sidebar.Trigger className="cursor-pointer rtl:rotate-180" />

			{/* Right side actions */}
			<div className="flex items-center gap-2">
				{/* View site link */}
				<LinkButton variant="ghost" size="sm" href="/" external>
					<ArrowSquareOut className="h-4 w-4 me-1" />
					{t`View Site`}
				</LinkButton>

				{/* Theme toggle */}
				<ThemeToggle />

				{/* User menu */}
				<Popover open={userMenuOpen} onOpenChange={setUserMenuOpen}>
					<Popover.Trigger asChild>
						<Button variant="ghost" size="sm" className="gap-2 py-1 h-auto">
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
							<div className="font-medium truncate">{user?.name || t`User`}</div>
							<div className="text-xs text-kumo-subtle truncate">{user?.email}</div>
						</div>
						<div className="grid gap-1">
							<Link
								to="/settings/security"
								onClick={() => setUserMenuOpen(false)}
								className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-kumo-tint"
							>
								<Shield className="h-4 w-4" />
								{t`Security Settings`}
							</Link>
							<Link
								to="/settings"
								onClick={() => setUserMenuOpen(false)}
								className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-kumo-tint"
							>
								<Gear className="h-4 w-4" />
								{t`Settings`}
							</Link>
							<hr className="my-1" />
							<button
								onClick={handleLogout}
								className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-kumo-danger hover:bg-kumo-danger/10 w-full text-start"
							>
								<SignOut className="h-4 w-4" />
								{t`Log out`}
							</button>
						</div>
					</Popover.Content>
				</Popover>
			</div>
		</header>
	);
}
