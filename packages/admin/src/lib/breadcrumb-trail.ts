import type { MessageDescriptor } from "@lingui/core";

export interface BreadcrumbRouteMeta {
	/** Path template of the parent route. Its `$params` take the child route's params. */
	parent?: string;
	/** Names the route's crumb. Defaults to the route's `pageTitle`. */
	label?: MessageDescriptor;
	/** The page names its own crumb with `useBreadcrumbLabel`. */
	dynamic?: true;
}

export interface BreadcrumbRouteData {
	pageTitle?: MessageDescriptor;
	breadcrumb?: BreadcrumbRouteMeta;
}

/**
 * What the mounted page said about its crumb: `null` until a page claims it. A `current` claim
 * names a dynamic route's crumb, and a `nested` claim adds a level below the route. An
 * `undefined` label means the page is still loading the name.
 */
export type BreadcrumbClaim =
	| null
	| { kind: "current"; label: string | undefined }
	| { kind: "nested"; label: string | undefined };

export interface Crumb {
	/** `undefined` while the page loads the name. */
	label: string | undefined;
	/** Every crumb but the last links somewhere. */
	href?: string;
}

export interface BreadcrumbLeaf {
	pathname: string;
	params: Record<string, string>;
	staticData: BreadcrumbRouteData;
}

const PATH_PARAM = /\$(\w+)/g;

/**
 * Builds the trail for the current page by following `breadcrumb.parent` from the leaf route.
 * Routes without a parent get no trail unless the page nests a level below them.
 */
export function resolveBreadcrumbTrail({
	leaf,
	lookup,
	translate,
	claim,
}: {
	leaf: BreadcrumbLeaf;
	lookup: (path: string) => BreadcrumbRouteData | undefined;
	translate: (descriptor: MessageDescriptor) => string;
	claim: BreadcrumbClaim;
}): Crumb[] {
	const meta = leaf.staticData.breadcrumb;
	if (!meta?.parent && claim?.kind !== "nested") return [];

	const routeLabel = (path: string, data: BreadcrumbRouteData | undefined) => {
		const descriptor = data?.breadcrumb?.label ?? data?.pageTitle;
		return descriptor ? translate(descriptor) : path;
	};

	const trail: Crumb[] = [];
	let parent = meta?.parent;
	while (parent) {
		const data = lookup(parent);
		trail.unshift({
			label: routeLabel(parent, data),
			href: parent.replace(PATH_PARAM, (_, name: string) =>
				encodeURIComponent(leaf.params[name] ?? ""),
			),
		});
		parent = data?.breadcrumb?.parent;
	}

	const ownLabel = routeLabel(leaf.pathname, leaf.staticData);
	if (claim?.kind === "nested") {
		trail.push({ label: ownLabel, href: leaf.pathname }, { label: claim.label });
	} else {
		trail.push({ label: meta?.dynamic && claim ? claim.label : ownLabel });
	}
	return trail;
}
