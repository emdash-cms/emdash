/**
 * Admin Branding Context
 *
 * Provides the configured admin white-label branding (custom logo, site name)
 * to pre-authentication pages (LoginPage, SignupPage, InviteAcceptPage) and
 * the authenticated SPA shell alike.
 *
 * The branding is read server-side from `admin.astro` (which has direct,
 * per-request access to `Astro.locals.emdash.config.admin` — no API round
 * trip) and passed down as a prop through `AdminWrapper` -> `AdminApp`, then
 * exposed here via context. This mirrors how `authProviders` reaches the
 * same pre-auth pages, and avoids a logo flash: the branding is present in
 * the initial render, not fetched asynchronously after mount.
 */

import * as React from "react";
import { createContext, useContext } from "react";

/** Configured admin white-label overrides (see `admin` in astro.config.mjs). */
export interface AdminBranding {
	/** URL or path to a custom logo image for the admin UI. */
	logo?: string;
	/** Custom name displayed in place of "EmDash". */
	siteName?: string;
}

const AdminBrandingContext = createContext<AdminBranding>({});

export interface AdminBrandingProviderProps {
	children: React.ReactNode;
	adminBranding: AdminBranding;
}

/**
 * Provider that makes the configured admin branding available to all
 * descendants, including pages rendered before authentication.
 */
export function AdminBrandingProvider({ children, adminBranding }: AdminBrandingProviderProps) {
	return (
		<AdminBrandingContext.Provider value={adminBranding}>{children}</AdminBrandingContext.Provider>
	);
}

/** Get the configured admin branding (empty object when not configured). */
export function useAdminBranding(): AdminBranding {
	return useContext(AdminBrandingContext);
}
