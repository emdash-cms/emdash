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
import { i18n } from "@lingui/core";
import type { Messages } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";

import { ThemeProvider } from "./components/ThemeProvider";
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
	/** Compiled Lingui messages for the active locale */
	messages?: Messages;
}

/**
 * Main Admin Application
 */
const EMPTY_PLUGINS: PluginAdmins = {};

export function AdminApp({
	pluginAdmins = EMPTY_PLUGINS,
	locale = "en",
	messages = {},
}: AdminAppProps) {
	React.useEffect(() => {
		document.getElementById("emdash-boot-loader")?.remove();
	}, []);

	React.useLayoutEffect(() => {
		if (!i18n.locale) {
			i18n.loadAndActivate({ locale, messages });
		}
	}, [locale, messages]);

	return (
		<ThemeProvider>
			<I18nProvider i18n={i18n}>
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
