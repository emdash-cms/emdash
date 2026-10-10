import type { PageLayoutBlock } from "../../emdash-env";

type Layout = readonly PageLayoutBlock[] | null | undefined;

/** Block types that render the page heading when they come first. */
const HEADING_BLOCK_TYPES = new Set<PageLayoutBlock["_type"]>([
	"portfolio_statement",
	"portfolio_contact",
]);

/**
 * Whether the layout opens with a block that renders the page's h1, so the
 * page shouldn't add its title as another one.
 */
export function startsWithHeading(layout: Layout): boolean {
	const first = layout?.[0];
	return first !== undefined && HEADING_BLOCK_TYPES.has(first._type);
}

/** The opening block's text, for the meta description when the SEO panel has none. */
export function layoutDescription(layout: Layout): string | undefined {
	const first = layout?.[0];
	let text: string | null | undefined;
	if (first?._type === "portfolio_contact") text = first.intro;
	else if (first?._type === "portfolio_statement") text = first.text;
	return text?.replace(/\s+/g, " ").trim() || undefined;
}
