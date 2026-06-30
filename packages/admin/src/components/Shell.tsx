import * as React from "react";

import { useCurrentUser } from "../lib/api/current-user";
import { getLocaleDir } from "../locales/config.js";
import { useLocale } from "../locales/useLocale.js";
import { AdminCommandPalette } from "./AdminCommandPalette";
import { Header } from "./Header";
import { Sidebar, SidebarNav } from "./Sidebar";
import { WelcomeModal } from "./WelcomeModal";

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

	// Show welcome modal on first login
	React.useEffect(() => {
		if (user?.isFirstLogin) {
			setWelcomeModalOpen(true);
		}
	}, [user?.isFirstLogin]);

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
				<main className="flex-1 overflow-y-auto p-6">{children}</main>
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
