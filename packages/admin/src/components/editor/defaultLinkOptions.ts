/**
 * Default options for TipTap's Link extension in the Portable Text editor.
 *
 * linkify treats bare `word.tld` strings (filenames, placeholders, dotted
 * identifiers) as URLs whenever the suffix is a real TLD, which made TipTap
 * create unwanted links with an inferred `http://` protocol while typing and
 * pasting. `shouldAutoLink` limits auto-detection to explicit URLs that have a
 * scheme or a `www.` prefix. Users can still create links deliberately with the
 * toolbar link button or Markdown `[text](url)` syntax.
 */

const PROTOCOL_REGEX = /^[a-z][a-z0-9+.-]*:\/\//i;
const WWW_PREFIX_REGEX = /^www\./i;

export const defaultLinkOptions = {
	openOnClick: false,
	enableClickSelection: true,
	HTMLAttributes: {
		class: "text-kumo-link underline",
	},
	shouldAutoLink: (url: string) => {
		return PROTOCOL_REGEX.test(url) || WWW_PREFIX_REGEX.test(url);
	},
};
