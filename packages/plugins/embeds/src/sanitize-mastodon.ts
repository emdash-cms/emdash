import sanitizeHtml from "sanitize-html";

const WRAPPER =
	/^(<astro-embed-mastodon[^>]*>\s*<template[^>]*\sshadowrootmode="open"[^>]*>)([\s\S]*)(<\/template>\s*<\/astro-embed-mastodon>)$/;

/**
 * Sanitizes the HTML rendered by astro-embed's MastodonPost.
 *
 * Only the shadow root's contents are sanitized, so post HTML cannot close the
 * wrapper elements and escape into the page. Returns an empty string for any
 * other markup.
 */
export function sanitizeMastodonEmbed(html: string): string {
	const trimmed = html.trim();
	if (!trimmed) return "";
	const match = WRAPPER.exec(trimmed);
	if (!match) {
		console.warn("[plugin-embeds] Mastodon embed markup not recognised; not rendering");
		return "";
	}

	// The embed's own stylesheet is the first <link>; any later one came from the remote server.
	let links = 0;
	const inner = sanitizeHtml(match[2] ?? "", {
		allowedTags: [
			...sanitizeHtml.defaults.allowedTags,
			"link",
			"img",
			"video",
			"audio",
			"source",
			"svg",
			"path",
			"title",
			"del",
		],
		allowedAttributes: {
			"*": ["part", "class", "dir", "lang", "title", "role", "aria-hidden", "aria-label"],
			link: ["rel", "href"],
			a: ["href", "rel", "target"],
			img: ["src", "srcset", "sizes", "alt", "width", "height", "loading", "decoding"],
			video: [
				"src",
				"poster",
				"preload",
				"controls",
				"loop",
				"muted",
				"playsinline",
				"width",
				"height",
			],
			audio: ["src", "preload", "controls"],
			source: ["src", "type"],
			svg: ["width", "height", "viewbox", "fill", "xmlns"],
			path: ["d", "fill"],
			time: ["datetime"],
		},
		allowedSchemes: ["http", "https"],
		allowedSchemesAppliedToAttributes: ["href", "src", "cite", "poster"],
		allowProtocolRelative: false,
		exclusiveFilter: (frame) => frame.tag === "link" && links++ > 0,
	});
	return match[1] + inner + match[3];
}
