/**
 * TipTap's default Code mark sets `excludes: '_'`, which drops every other
 * mark on the same span. Portable Text allows decorator + annotation stacks
 * (e.g. linked inline code), so override only that field.
 */

import Code from "@tiptap/extension-code";

export const CodeMarkExtension = Code.extend({
	excludes: "",
});
