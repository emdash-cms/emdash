/**
 * Plugin Admin Context
 *
 * Provides plugin admin modules (widgets, pages, fields) to the admin UI
 * via React context. This avoids cross-module registry issues by keeping
 * everything in React's component tree.
 */

import * as React from "react";
import { createContext, useContext } from "react";

/** Shape of a plugin's admin exports */
export interface PluginAdminModule {
	widgets?: Record<string, React.ComponentType>;
	pages?: Record<string, React.ComponentType>;
	fields?: Record<string, React.ComponentType>;
}

/** All plugin admin modules keyed by plugin ID */
export type PluginAdmins = Record<string, PluginAdminModule>;

const PluginAdminContext = createContext<PluginAdmins>({});

export interface PluginAdminProviderProps {
	children: React.ReactNode;
	pluginAdmins: PluginAdmins;
}

/**
 * Provider that makes plugin admin modules available to all descendants
 */
export function PluginAdminProvider({ children, pluginAdmins }: PluginAdminProviderProps) {
	return <PluginAdminContext.Provider value={pluginAdmins}>{children}</PluginAdminContext.Provider>;
}

/**
 * Get all plugin admin modules
 */
export function usePluginAdmins(): PluginAdmins {
	return useContext(PluginAdminContext);
}

/**
 * Get a dashboard widget component by plugin ID and widget ID
 */
export function usePluginWidget(pluginId: string, widgetId: string): React.ComponentType | null {
	const admins = useContext(PluginAdminContext);
	return admins[pluginId]?.widgets?.[widgetId] ?? null;
}

function togglePagePathTrailingSlash(path: string): string {
	if (path === "/") return path;
	return path.endsWith("/") ? path.slice(0, -1) : `${path}/`;
}

/**
 * Resolve a plugin page component by path, treating a trailing slash as equivalent and falling back to the first registered page at the root
 */
export function resolvePluginPagePath(
	pages: Record<string, React.ComponentType> | undefined,
	path: string,
): React.ComponentType | null {
	if (!pages) return null;
	const match = pages[path] ?? pages[togglePagePathTrailingSlash(path)];
	if (match) return match;
	// The Plugin Manager gear opens a plugin at "/plugins/<id>/", so the root
	// falls back to the first registered page when no page is keyed at "/".
	if (path === "/") return Object.values(pages)[0] ?? null;
	return null;
}

/**
 * Get a plugin page component by plugin ID and path, with trailing-slash and root-fallback resolution
 */
export function usePluginPage(pluginId: string, path: string): React.ComponentType | null {
	const admins = useContext(PluginAdminContext);
	return resolvePluginPagePath(admins[pluginId]?.pages, path);
}

/**
 * Get a field widget component by plugin ID and field type
 */
export function usePluginField(pluginId: string, fieldType: string): React.ComponentType | null {
	const admins = useContext(PluginAdminContext);
	return admins[pluginId]?.fields?.[fieldType] ?? null;
}

/**
 * Check if a plugin has any registered admin pages
 */
export function usePluginHasPages(pluginId: string): boolean {
	const admins = useContext(PluginAdminContext);
	const pages = admins[pluginId]?.pages;
	return pages !== undefined && Object.keys(pages).length > 0;
}

/**
 * Check if a plugin has any registered dashboard widgets
 */
export function usePluginHasWidgets(pluginId: string): boolean {
	const admins = useContext(PluginAdminContext);
	const widgets = admins[pluginId]?.widgets;
	return widgets !== undefined && Object.keys(widgets).length > 0;
}
