/**
 * emdash/page — Public page contribution API
 *
 * Template integration points for plugin-driven head metadata
 * and trusted body fragments.
 */

import type {
	PublicPageContext,
	PageMetadataContribution,
	PageFragmentContribution,
} from "../plugins/types.js";

export { createPublicPageContext } from "./context.js";
export type { CreatePublicPageContextInput } from "./context.js";

export {
	resolvePageMetadata,
	renderPageMetadata,
	safeJsonLdSerialize,
	escapeHtmlAttr,
} from "./metadata.js";
export type { ResolvedPageMetadata } from "./metadata.js";

export { resolveFragments, renderFragments } from "./fragments.js";

export { generateBaseSeoContributions, generateSiteSeoContributions } from "./seo-contributions.js";
export { cleanJsonLd, buildBlogPostingJsonLd, buildWebSiteJsonLd } from "./jsonld.js";

/**
 * Shape of the EmDash runtime methods used by the render components.
 * Extracted here so all three components share a single type definition.
 */
export interface EmDashPageRuntime {
	collectPageMetadata: (page: PublicPageContext) => Promise<PageMetadataContribution[]>;
	collectPageFragments: (page: PublicPageContext) => Promise<PageFragmentContribution[]>;
}

/**
 * Get the page runtime from Astro locals. Returns undefined when
 * EmDash is not initialized (components render nothing in that case).
 */
export function getPageRuntime(locals: Record<string, unknown>): EmDashPageRuntime | undefined {
	const emdash = locals.emdash;
	if (
		emdash &&
		typeof emdash === "object" &&
		"collectPageMetadata" in emdash &&
		"collectPageFragments" in emdash
	) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- structural check above confirms presence of required methods
		return emdash as EmDashPageRuntime;
	}
	return undefined;
}

// Astro render components are exported from "emdash/ui":
//   import { EmDashHead, EmDashBodyStart, EmDashBodyEnd } from "emdash/ui";
