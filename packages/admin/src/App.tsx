/**
 * EmDash Admin React Application
 *
 * This is the main entry point for the admin SPA.
 * Uses TanStack Router for client-side routing and TanStack Query for data fetching.
 *
 * Plugin admin components are passed via the pluginAdmins prop and made
 * available throughout the app via PluginAdminContext.
 */

import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";

import { ThemeProvider } from "./components/ThemeProvider";
import { I18nProvider, type Translations } from "./i18n/index.js";
import { PluginAdminProvider, type PluginAdmins } from "./lib/plugin-context";
import { createAdminRouter } from "./router";

// Create a query client
const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 1000 * 60, // 1 minute
			retry: 1,
		},
	},
});

// Create the router with query client context
const router = createAdminRouter(queryClient);

export interface AdminAppProps {
	/** Plugin admin modules keyed by plugin ID */
	pluginAdmins?: PluginAdmins;
	/** Active locale code */
	locale?: string;
	/** Translation strings for the active locale */
	translations?: Translations;
}

/**
 * Main Admin Application
 */
const EMPTY_PLUGINS: PluginAdmins = {};

export function AdminApp({
	pluginAdmins = EMPTY_PLUGINS,
	locale = "en",
	translations = {},
}: AdminAppProps) {
	React.useEffect(() => {
		document.getElementById("emdash-boot-loader")?.remove();
	}, []);

	return (
		<ThemeProvider>
			<I18nProvider locale={locale} translations={translations}>
				<Toasty>
					<PluginAdminProvider pluginAdmins={pluginAdmins}>
						<QueryClientProvider client={queryClient}>
							<RouterProvider router={router} />
						</QueryClientProvider>
					</PluginAdminProvider>
				</Toasty>
			</I18nProvider>
		</ThemeProvider>
	);
}

export default AdminApp;
