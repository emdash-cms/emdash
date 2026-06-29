/**
 * EmDash Admin React Application
 *
 * This is the main entry point for the admin SPA.
 * Uses TanStack Router for client-side routing and TanStack Query for data fetching.
 *
 * Plugin admin components are passed via the pluginAdmins prop and made
 * available throughout the app via PluginAdminContext.
 */

import { LinkProvider, Toasty, type LinkComponentProps } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import type { Messages } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Link, RouterProvider, type LinkProps } from "@tanstack/react-router";
import * as React from "react";

import { ThemeProvider } from "./components/ThemeProvider";
import { AuthProviderProvider, type AuthProviders } from "./lib/auth-provider-context";
import { PluginAdminProvider, type PluginAdmins } from "./lib/plugin-context";
import { LocaleDirectionProvider } from "./locales/index.js";
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
const ADMIN_BASEPATH = "/_emdash/admin";

function normalizeAdminHref(href: string): string {
	if (href === ADMIN_BASEPATH) return "/";
	if (href.startsWith(`${ADMIN_BASEPATH}/`)) return href.slice(ADMIN_BASEPATH.length);
	if (href.startsWith(`${ADMIN_BASEPATH}?`) || href.startsWith(`${ADMIN_BASEPATH}#`)) {
		return `/${href.slice(ADMIN_BASEPATH.length)}`;
	}
	return href;
}

function getAnchorHref(destination: string, routerDestination: string): string {
	if (routerDestination.startsWith("/") && !routerDestination.startsWith("//")) {
		if (
			routerDestination === "/" ||
			routerDestination.startsWith("/?") ||
			routerDestination.startsWith("/#")
		) {
			return `${ADMIN_BASEPATH}${routerDestination.slice(1)}`;
		}
		return `${ADMIN_BASEPATH}${routerDestination}`;
	}
	return destination;
}

const KumoRouterLink = React.forwardRef<HTMLAnchorElement, LinkComponentProps>(
	({ href, to, target, download, children, ...props }, ref) => {
		const destination = href ?? to ?? "";
		const hasSearchOrHash = destination.includes("?") || destination.includes("#");
		const routerDestination = normalizeAdminHref(destination);
		const isRouterPath = routerDestination.startsWith("/") && !routerDestination.startsWith("//");
		const shouldUseAnchor = !isRouterPath || hasSearchOrHash || target || download != null;
		const linkProps = props as LinkComponentProps & {
			"aria-current"?: React.AriaAttributes["aria-current"];
			"data-active"?: boolean | string;
		};
		const ariaCurrent =
			linkProps["aria-current"] ?? (linkProps["data-active"] ? "page" : undefined);

		if (shouldUseAnchor) {
			const anchorHref =
				hasSearchOrHash && !target && download == null
					? getAnchorHref(destination, routerDestination)
					: destination;
			return (
				<a ref={ref} href={anchorHref} target={target} download={download} {...props}>
					{children}
				</a>
			);
		}

		return (
			<Link
				// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Kumo provides runtime hrefs; TanStack requires literal route types.
				{...(props as Omit<LinkProps, "to" | "children">)}
				ref={ref}
				// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Kumo provides runtime hrefs; TanStack requires literal route types.
				to={routerDestination as "/"}
				aria-current={ariaCurrent}
			>
				{children}
			</Link>
		);
	},
);

KumoRouterLink.displayName = "KumoRouterLink";

export interface AdminAppProps {
	/** Plugin admin modules keyed by plugin ID */
	pluginAdmins?: PluginAdmins;
	/** Auth provider UI modules keyed by provider ID */
	authProviders?: AuthProviders;
	/** Active locale code */
	locale?: string;
	/** Compiled Lingui messages for the active locale */
	messages?: Messages;
}

/**
 * Main Admin Application
 */
const EMPTY_PLUGINS: PluginAdmins = {};
const EMPTY_AUTH_PROVIDERS: AuthProviders = {};

export function AdminApp({
	pluginAdmins = EMPTY_PLUGINS,
	authProviders = EMPTY_AUTH_PROVIDERS,
	locale = "en",
	messages = {},
}: AdminAppProps) {
	React.useEffect(() => {
		document.getElementById("emdash-boot-loader")?.remove();
	}, []);

	const i18nInitialized = React.useRef(false);
	if (!i18nInitialized.current) {
		i18n.loadAndActivate({ locale, messages });
		i18nInitialized.current = true;
	}

	return (
		<ThemeProvider>
			<I18nProvider i18n={i18n}>
				<LocaleDirectionProvider>
					<Toasty>
						<AuthProviderProvider authProviders={authProviders}>
							<PluginAdminProvider pluginAdmins={pluginAdmins}>
								<QueryClientProvider client={queryClient}>
									<LinkProvider component={KumoRouterLink}>
										<RouterProvider router={router} />
									</LinkProvider>
								</QueryClientProvider>
							</PluginAdminProvider>
						</AuthProviderProvider>
					</Toasty>
				</LocaleDirectionProvider>
			</I18nProvider>
		</ThemeProvider>
	);
}

export default AdminApp;
