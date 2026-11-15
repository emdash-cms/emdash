import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { fetchSettings, type SiteSettings } from "./api/settings.js";

const SITE_SETTINGS_QUERY_KEY = ["settings"] as const;
const DEFAULT_COLOR = "#000000";

type SiteColors = NonNullable<NonNullable<SiteSettings["theme"]>["colors"]>;
export type SiteColorKey = keyof SiteColors;

export interface SiteSettingsContextValue {
	settings: Partial<SiteSettings> | undefined;
	isLoading: boolean;
	error: Error | null;
	getLogoUrl: () => string | undefined;
	getLogoAlt: (fallback?: string) => string;
	getColor: (key: SiteColorKey) => string;
}

const SiteSettingsContext = React.createContext<SiteSettingsContextValue | undefined>(undefined);

export interface SiteSettingsProviderProps {
	children: React.ReactNode;
}

export function SiteSettingsProvider({ children }: SiteSettingsProviderProps) {
	const query = useQuery({
		queryKey: SITE_SETTINGS_QUERY_KEY,
		queryFn: fetchSettings,
		staleTime: Infinity,
	});

	const settings = query.data;
	const value = React.useMemo<SiteSettingsContextValue>(
		() => ({
			settings,
			isLoading: query.isLoading,
			error:
				query.error instanceof Error
					? query.error
					: query.error
						? new Error("Settings unavailable")
						: null,
			getLogoUrl: () => getSiteLogoUrl(settings),
			getLogoAlt: (fallback = "") => getSiteLogoAlt(settings, fallback),
			getColor: (key) => getSiteColor(settings, key),
		}),
		[query.error, query.isLoading, settings],
	);

	return <SiteSettingsContext.Provider value={value}>{children}</SiteSettingsContext.Provider>;
}

export function useSiteSettings(): SiteSettingsContextValue {
	const context = React.useContext(SiteSettingsContext);
	if (!context) {
		throw new Error("useSiteSettings must be used within SiteSettingsProvider");
	}
	return context;
}

export function getSiteLogoUrl(settings: Partial<SiteSettings> | undefined): string | undefined {
	return settings?.logo?.url;
}

export function getSiteLogoAlt(settings: Partial<SiteSettings> | undefined, fallback = ""): string {
	return settings?.logo?.alt || settings?.title || fallback;
}

export function getSiteColor(
	settings: Partial<SiteSettings> | undefined,
	key: SiteColorKey,
): string {
	return settings?.theme?.colors?.[key] ?? DEFAULT_COLOR;
}

export { DEFAULT_COLOR, SITE_SETTINGS_QUERY_KEY };
