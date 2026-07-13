import { LinkProvider, Toasty, type LinkComponentProps } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import type { Messages } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Link, RouterProvider, type LinkProps } from "@tanstack/react-router";
import * as React from "react";

import { LocaleDirectionProvider } from "./locales/index.js";
import { createConsoleRouter } from "./router.js";

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 1000 * 60,
			retry: 1,
		},
	},
});

const router = createConsoleRouter(queryClient);

/** Kumo components navigate via a plain `href`; this maps router-internal
 * paths (leading "/", no target/download) to a TanStack Router Link so they
 * get client-side navigation, and falls back to a real anchor otherwise —
 * mirrors packages/admin's App.tsx without that package's admin-basepath
 * href rewriting, which this console's flat `/admin` basepath doesn't need. */
const KumoRouterLink = React.forwardRef<HTMLAnchorElement, LinkComponentProps>(
	function KumoRouterLink({ href, to, target, download, children, ...props }, ref) {
		const destination = href ?? to ?? "";
		const isRouterPath = destination.startsWith("/") && !destination.startsWith("//");

		if (!isRouterPath || target || download != null) {
			return (
				<a ref={ref} href={destination} target={target} download={download} {...props}>
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
				to={destination as "/"}
			>
				{children}
			</Link>
		);
	},
);

export interface ConsoleAppProps {
	locale?: string;
	messages?: Messages;
}

export function ConsoleApp({ locale = "en", messages = {} }: ConsoleAppProps) {
	const i18nInitialized = React.useRef(false);
	if (!i18nInitialized.current) {
		i18n.loadAndActivate({ locale, messages });
		i18nInitialized.current = true;
	}

	return (
		<I18nProvider i18n={i18n}>
			<LocaleDirectionProvider>
				<Toasty>
					<QueryClientProvider client={queryClient}>
						<LinkProvider component={KumoRouterLink}>
							<RouterProvider router={router} />
						</LinkProvider>
					</QueryClientProvider>
				</Toasty>
			</LocaleDirectionProvider>
		</I18nProvider>
	);
}

export default ConsoleApp;
