import * as React from "react";

import { Header } from "./Header.js";
import { Sidebar, SidebarNav } from "./Sidebar.js";

export interface ShellProps {
	children: React.ReactNode;
}

/** Console shell layout with Kumo's Sidebar component, mirroring
 * packages/admin's Shell.tsx. */
export function Shell({ children }: ShellProps) {
	return (
		<Sidebar.Provider
			defaultOpen
			style={
				{
					"--sidebar-bg": "var(--color-kumo-elevated)",
					height: "100svh",
					minHeight: "0",
					overflow: "hidden",
				} as React.CSSProperties
			}
		>
			<SidebarNav />
			<div className="flex flex-1 flex-col overflow-hidden">
				<Header />
				<main className="flex-1 overflow-y-auto p-6">{children}</main>
			</div>
		</Sidebar.Provider>
	);
}
