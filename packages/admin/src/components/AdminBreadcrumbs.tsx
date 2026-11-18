import { Breadcrumbs } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { type AnyRoute, useMatches, useRouter } from "@tanstack/react-router";
import * as React from "react";

import { type BreadcrumbClaim, resolveBreadcrumbTrail } from "../lib/breadcrumb-trail.js";

interface PageClaim {
	pageKey: string;
	claim: NonNullable<BreadcrumbClaim>;
}

const BreadcrumbSetterContext = React.createContext<{
	pageKey: string;
	setClaim: React.Dispatch<React.SetStateAction<PageClaim | null>>;
} | null>(null);

const BreadcrumbClaimContext = React.createContext<BreadcrumbClaim>(null);

/**
 * Holds the current page's claim on its crumb. Pages only see the setter, so a claim re-renders
 * the trail and nothing else. A claim made under another `pageKey` is ignored.
 */
export function BreadcrumbProvider({
	pageKey,
	children,
}: {
	pageKey: string;
	children: React.ReactNode;
}) {
	const [pageClaim, setClaim] = React.useState<PageClaim | null>(null);
	const setter = React.useMemo(() => ({ pageKey, setClaim }), [pageKey]);
	const claim = pageClaim?.pageKey === pageKey ? pageClaim.claim : null;
	return (
		<BreadcrumbSetterContext.Provider value={setter}>
			<BreadcrumbClaimContext.Provider value={claim}>{children}</BreadcrumbClaimContext.Provider>
		</BreadcrumbSetterContext.Provider>
	);
}

/**
 * Names the current page's crumb on a route marked `breadcrumb.dynamic`. `undefined` shows a
 * loading skeleton. With `nested`, the label becomes a level below the route, whose own crumb
 * then links to the route without its search parameters.
 */
export function useBreadcrumbLabel(label: string | undefined, options?: { nested?: boolean }) {
	const context = React.useContext(BreadcrumbSetterContext);
	const kind = options?.nested ? "nested" : "current";
	React.useLayoutEffect(() => {
		if (!context) return;
		const entry: PageClaim = { pageKey: context.pageKey, claim: { kind, label } };
		context.setClaim(entry);
		return () => context.setClaim((current) => (current === entry ? null : current));
	}, [context, kind, label]);
}

export function AdminBreadcrumbs() {
	const { i18n } = useLingui();
	const claim = React.useContext(BreadcrumbClaimContext);
	const routesByPath: Record<string, AnyRoute | undefined> = useRouter().routesByPath;
	const leaf = useMatches({ select: (matches) => matches.at(-1) });
	if (!leaf) return null;

	const trail = resolveBreadcrumbTrail({
		leaf: {
			pathname: leaf.pathname,
			params: leaf.params,
			staticData: leaf.staticData,
		},
		lookup: (path) => routesByPath[path]?.options.staticData,
		translate: (descriptor) => i18n._(descriptor),
		claim,
	});
	if (trail.length === 0) return null;

	return (
		<Breadcrumbs size="sm" className="me-0">
			{trail.map((crumb) =>
				crumb.href === undefined ? (
					<Breadcrumbs.Current key="current" loading={crumb.label === undefined}>
						{/* Truncates inside the isolate so a name in the other direction keeps its start. */}
						<span dir="auto" className="block truncate">
							{crumb.label}
						</span>
					</Breadcrumbs.Current>
				) : (
					[
						<Breadcrumbs.Link key={`link:${crumb.href}`} href={crumb.href}>
							<span dir="auto">{crumb.label}</span>
						</Breadcrumbs.Link>,
						<Breadcrumbs.Separator key={`separator:${crumb.href}`} />,
					]
				),
			)}
		</Breadcrumbs>
	);
}
