/**
 * Shared mark component map for Portable Text rendering.
 *
 * Used by both the top-level `emdashComponents` config and individual block
 * components (e.g. Table) that render nested inline content through the PT
 * pipeline.
 */
import LinkMark from "./marks/Link.astro";
import StrikeThroughMark from "./marks/StrikeThrough.astro";
import SubscriptMark from "./marks/Subscript.astro";
import SuperscriptMark from "./marks/Superscript.astro";
import UnderlineMark from "./marks/Underline.astro";

export const emdashMarkComponents = {
	superscript: SuperscriptMark,
	subscript: SubscriptMark,
	underline: UnderlineMark,
	"strike-through": StrikeThroughMark,
	link: LinkMark,
};
