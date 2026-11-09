import { normalizePluginPagePath } from "@emdash-cms/blocks";
import type { MessageDescriptor } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import { useLocation, useMatches } from "@tanstack/react-router";
import * as React from "react";

import type { AdminManifest } from "../lib/api/client.js";
import { useCurrentUser } from "../lib/api/current-user";
import { getLocaleDir } from "../locales/config.js";
import { useLocale } from "../locales/useLocale.js";
import { AdminCommandPalette } from "./AdminCommandPalette";
import { AdminDocumentTitle } from "./AdminDocumentTitle.js";
import { Header } from "./Header";
import { RegistryConfigurationBanner } from "./RegistryConfigurationBanner.js";
import {
	Sidebar,
	SidebarNav,
	getSidebarTaxonomies,
	resolvePluginPageLabel,
	declaredLabelTranslator,
} from "./Sidebar";
import { WelcomeModal } from "./WelcomeModal";

declare module "@tanstack/react-router" {
	interface StaticDataRouteOption {
		/**
		 * Route renders edge-to-edge: the Shell's <main> drops its padding and
		 * page scroll, and the route's component manages its own scroll regions.
		 */
		fullBleed?: boolean;
		pageTitle?: MessageDescriptor;
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
				adminPages?: Array<{ path: string; label?: string; icon?: string; group?: string }>;
			}
		>;
		taxonomies: Array<{
			id?: string;
			name: string;
			label: string;
			locale?: string;
			translationGroup?: string | null;
		}>;
		i18n?: { defaultLocale: string; locales: string[] };
		version?: string;
		siteTitle?: string;
		admin?: AdminManifest["admin"];
		registryConfigurationError?: AdminManifest["registryConfigurationError"];
		staging?: boolean;
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
	const { t, i18n } = useLingui();

	const { data: user } = useCurrentUser();
	const { locale } = useLocale();
	const sidebarSide = getLocaleDir(locale) === "rtl" ? "right" : "left";
	const fullBleed = useMatches({
		select: (matches) => matches.some((match) => match.staticData.fullBleed),
	});

	const match = useMatches({ select: (matches) => matches.at(-1) });
	const routeLocale = useLocation({
		select: (location) =>
			new URL(location.href, "http://emdash.local").searchParams.get("locale") ?? undefined,
	});
	const params = (match?.params ?? {}) as Record<string, string>;
	let pageTitle = match?.staticData.pageTitle ? t(match.staticData.pageTitle) : t`Dashboard`;
	if (params.collection) {
		pageTitle = manifest.collections[params.collection]?.label ?? pageTitle;
	} else if (params.taxonomy) {
		pageTitle =
			getSidebarTaxonomies(manifest.taxonomies, routeLocale, manifest.i18n?.defaultLocale).find(
				(taxonomy) => taxonomy.name === params.taxonomy,
			)?.label ?? pageTitle;
	} else if (params.pluginId && params._splat !== undefined) {
		const pluginPage = manifest.plugins[params.pluginId]?.adminPages?.find(
			(candidate) => normalizePluginPagePath(candidate.path) === `/${params._splat || ""}`,
		);
		if (pluginPage) {
			pageTitle = resolvePluginPageLabel(
				pluginPage.label,
				params.pluginId,
				declaredLabelTranslator(i18n, (id) => i18n._(id)),
			);
		}
	}

	// Show welcome modal on first login
	React.useEffect(() => {
		if (user?.isFirstLogin) {
			setWelcomeModalOpen(true);
		}
	}, [user?.isFirstLogin]);

	// Maintain the non-secret "an editor session may exist in this browser"
	// localStorage flag consumed by the public-site toolbar bootstrap
	// (`toolbar: "client"`). Set here — not in the login
	// flows — so every auth method (passkey, OAuth, magic link, dev bypass)
	// is covered. Opening the admin also un-dismisses the toolbar.
	// Key literals are duplicated in emdash core, which the admin can't import.
	React.useEffect(() => {
		if (!user) return;
		try {
			if (user.role >= 30) {
				localStorage.setItem("emdash-editor", "1");
				localStorage.setItem(
					"emdash-toolbar-labels",
					JSON.stringify({ editMode: t`Edit`, hideToolbar: t`Hide toolbar` }),
				);
				localStorage.removeItem("emdash-toolbar-dismissed");
			} else {
				localStorage.removeItem("emdash-editor");
				localStorage.removeItem("emdash-toolbar-labels");
			}
		} catch {
			// localStorage unavailable — the toolbar pill just won't appear
		}
	}, [t, user]);

	return (
		<AdminDocumentTitle
			siteName={manifest.siteTitle}
			pageKey={match?.pathname ?? "/"}
			pageTitle={pageTitle}
		>
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
					<Header staging={manifest.staging} />
					{manifest.registryConfigurationError && (
						<div className="space-y-3 px-6 pt-6">
							<RegistryConfigurationBanner error={manifest.registryConfigurationError} />
						</div>
					)}
					{/* Full-bleed clips because scrollIntoView() and focus() can still scroll
				    an overflow-hidden box, pushing the page up under the header. A
				    clipping box isn't a scroll container, so it also needs min-h-0. */}
					<main
						className={
							fullBleed
								? "min-h-0 flex-1 overflow-clip bg-kumo-elevated"
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
		</AdminDocumentTitle>
	);
}
