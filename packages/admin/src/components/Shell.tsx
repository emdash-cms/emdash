import { useMatches } from "@tanstack/react-router";
import * as React from "react";

import { useCurrentUser } from "../lib/api/current-user";
import { getLocaleDir } from "../locales/config.js";
import { useLocale } from "../locales/useLocale.js";
import { AdminCommandPalette } from "./AdminCommandPalette";
import { Header } from "./Header";
import { Sidebar, SidebarNav } from "./Sidebar";
import { WelcomeModal } from "./WelcomeModal";

declare module "@tanstack/react-router" {
	interface StaticDataRouteOption {
		/**
		 * Route renders edge-to-edge: the Shell's <main> drops its padding and
		 * page scroll, and the route's component manages its own scroll regions.
		 */
		fullBleed?: boolean;
	}
}

export interface ShellProps {
	children: React.ReactNode;
	manifest: {
		collections: Record<string, { label: string }>;
		plugins: Record<
			string,
			{
				package?: string;
				adminPages?: Array<{ path: string; label?: string; icon?: string }>;
			}
		>;
		taxonomies: Array<{
			name: string;
			label: string;
		}>;
		version?: string;
	};
}

/**
 * Admin shell layout with kumo Sidebar component.
 *
 * Sidebar.Provider wraps both the sidebar and main content area,
 * handling collapse state, mobile detection, and layout transitions.
 */
export function Shell({ children, manifest }: ShellProps) {
	const [welcomeModalOpen, setWelcomeModalOpen] = React.useState(false);

	const { data: user } = useCurrentUser();
	const { locale } = useLocale();
	const sidebarSide = getLocaleDir(locale) === "rtl" ? "right" : "left";
	const fullBleed = useMatches({
		select: (matches) => matches.some((match) => match.staticData.fullBleed),
	});

	// Show welcome modal on first login
	React.useEffect(() => {
		if (user?.isFirstLogin) {
			setWelcomeModalOpen(true);
		}
	}, [user?.isFirstLogin]);

	// Maintain the non-secret "an editor session may exist in this browser"
	// localStorage flag consumed by the public-site toolbar bootstrap
	// (`toolbar: "client"`, Discussion #1742). Set here — not in the login
	// flows — so every auth method (passkey, OAuth, magic link, dev bypass)
	// is covered. Opening the admin also un-dismisses the toolbar.
	// Key literals are duplicated in emdash core, which the admin can't import.
	React.useEffect(() => {
		if (!user) return;
		try {
			if (user.role >= 30) {
				localStorage.setItem("emdash-editor", "1");
				localStorage.removeItem("emdash-toolbar-dismissed");
			} else {
				localStorage.removeItem("emdash-editor");
			}
		} catch {
			// localStorage unavailable — the toolbar pill just won't appear
		}
	}, [user]);

	return (
		<Sidebar.Provider
			defaultOpen
			side={sidebarSide}
			style={
				{
					"--sidebar-bg": "var(--color-kumo-elevated)",
					height: "100svh",
					minHeight: "0",
					overflow: "hidden",
				} as React.CSSProperties
			}
		>
			{/* Sidebar navigation */}
			<SidebarNav manifest={manifest} />

			{/* Main content area — scrolls independently so sidebar stays full height */}
			<div className="flex flex-1 flex-col overflow-hidden">
				<Header />
				<main
					className={
						fullBleed
							? "flex-1 overflow-hidden bg-kumo-elevated"
							: "flex-1 overflow-y-auto bg-kumo-elevated p-6"
					}
				>
					{children}
				</main>
			</div>

			{/* Welcome modal for first-time users */}
			{user && (
				<WelcomeModal
					open={welcomeModalOpen}
					onClose={() => setWelcomeModalOpen(false)}
					userName={user.name}
					userRole={user.role}
				/>
			)}

			{/* Command palette for quick navigation */}
			<AdminCommandPalette manifest={manifest} />
		</Sidebar.Provider>
	);
}
