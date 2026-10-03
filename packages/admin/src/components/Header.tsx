import { Button, DropdownMenu, LinkButton } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { SignOut, Shield, Gear, ArrowSquareOut, CaretDown } from "@phosphor-icons/react";

import { apiFetch } from "../lib/api/client";
import { useCurrentUser, type CurrentUser } from "../lib/api/current-user";
import { cn } from "../lib/utils";
import { Sidebar } from "./Sidebar";
import { ThemeToggle } from "./ThemeToggle";

export type { CurrentUser } from "../lib/api/current-user";

async function handleLogout() {
	// Clear the public-site toolbar-bootstrap flag (see Shell.tsx).
	try {
		localStorage.removeItem("emdash-editor");
		localStorage.removeItem("emdash-toolbar-labels");
	} catch {
		// ignore — flag is best-effort
	}
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

function UserAvatar({ user, className }: { user: CurrentUser | undefined; className: string }) {
	if (user?.avatarUrl) {
		return (
			<img src={user.avatarUrl} alt="" className={cn("rounded-full object-cover", className)} />
		);
	}
	const initial = (user?.name || user?.email || "U").charAt(0).toUpperCase();
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex shrink-0 items-center justify-center rounded-full bg-kumo-brand/10 font-medium text-kumo-default",
				className,
			)}
		>
			{initial}
		</span>
	);
}

const headerButtonClass = "h-8 gap-1.5 px-2.5 text-sm";
const headerIconClass = "size-3.5";
const menuItemClass = "gap-2.5 py-2 data-highlighted:bg-kumo-tint";
const menuIconClass = "size-4 text-kumo-subtle in-data-highlighted:text-kumo-default";

/**
 * Admin header with mobile menu toggle and user actions.
 */
export function Header() {
	const { t } = useLingui();
	const { data: user } = useCurrentUser();

	return (
		// h-[58px] is mirrored by ADMIN_HEADER_HEIGHT_PX in ContentEditor.tsx
		// (the settings sheet offsets its body by it) — change both together.
		<header className="sticky top-0 z-10 flex h-[58px] items-center justify-end border-b bg-kumo-elevated px-4">
			{/* The desktop trigger lives in the sidebar footer; mobile keeps it here so the closed sheet can reopen. */}
			<Sidebar.Trigger className="me-auto cursor-pointer md:hidden rtl:rotate-180" />

			<div className="flex items-center gap-1">
				<LinkButton variant="ghost" href="/" external className={headerButtonClass}>
					<ArrowSquareOut className={headerIconClass} aria-hidden="true" />
					<span className="max-sm:sr-only">{t`View Site`}</span>
				</LinkButton>

				<ThemeToggle
					className={headerButtonClass}
					iconClassName={headerIconClass}
					labelClassName="max-sm:sr-only"
				/>

				<DropdownMenu>
					<DropdownMenu.Trigger
						render={
							<Button variant="ghost" className={cn(headerButtonClass, "max-w-56 px-2")}>
								<UserAvatar user={user} className="size-5 text-[11px]" />
								<span className="min-w-0 truncate max-sm:sr-only">
									{user?.name || user?.email || t`User`}
								</span>
								<CaretDown className="size-3 shrink-0" aria-hidden="true" />
							</Button>
						}
					/>

					<DropdownMenu.Content
						align="end"
						className="w-64 origin-[var(--transform-origin)] rounded-xl p-1.5 transition-[transform,scale,opacity] duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[instant]:duration-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 motion-reduce:transition-none"
					>
						<DropdownMenu.Group>
							<DropdownMenu.Label className="px-2 pt-2 pb-2.5 font-normal">
								<div className="truncate font-medium">{user?.name || t`User`}</div>
								{user?.email && (
									<div className="truncate text-sm text-kumo-subtle">{user.email}</div>
								)}
							</DropdownMenu.Label>
							<DropdownMenu.Item
								href="/settings/security"
								className={menuItemClass}
								icon={<Shield className={menuIconClass} aria-hidden="true" />}
							>
								{t`Security`}
							</DropdownMenu.Item>
							<DropdownMenu.Item
								href="/settings"
								className={menuItemClass}
								icon={<Gear className={menuIconClass} aria-hidden="true" />}
							>
								{t`Settings`}
							</DropdownMenu.Item>
						</DropdownMenu.Group>
						<DropdownMenu.Separator />
						<DropdownMenu.Item
							variant="danger"
							className="gap-2.5 py-2"
							icon={<SignOut className="size-4 rtl:-scale-x-100" aria-hidden="true" />}
							onClick={handleLogout}
						>
							{t`Log out`}
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu>
			</div>
		</header>
	);
}
