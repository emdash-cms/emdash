/**
 * Block schemas for embed types
 *
 * These define the Portable Text block structure for each embed type.
 * The schemas match the props expected by astro-embed components.
 */

import { z } from "astro/zod";

/** Matches http(s) scheme at start of URL */
const HTTP_SCHEME_RE = /^https?:\/\//i;

/** Validates that a URL string uses http or https scheme. Rejects javascript:/data: URI XSS vectors. */
const httpUrl = z.url().refine((url) => HTTP_SCHEME_RE.test(url), "URL must use http or https");

/**
 * YouTube embed block
 * @see https://astro-embed.netlify.app/components/youtube/
 */
export const youtubeBlockSchema = z.object({
	_type: z.literal("youtube"),
	_key: z.string(),
	/** YouTube video ID or URL */
	id: z.string(),
	/** Custom poster image URL */
	poster: httpUrl.optional(),
	/** Poster quality when using default YouTube thumbnail */
	posterQuality: z.enum(["max", "high", "default", "low"]).optional(),
	/** YouTube player parameters (e.g., "start=57&end=75") */
	params: z.string().optional(),
	/** Accessible label for the play button */
	playlabel: z.string().optional(),
	/** Visible title overlay */
	title: z.string().optional(),
});

export type YouTubeBlock = z.infer<typeof youtubeBlockSchema>;

/**
 * Vimeo embed block
 * @see https://astro-embed.netlify.app/components/vimeo/
 */
export const vimeoBlockSchema = z.object({
	_type: z.literal("vimeo"),
	_key: z.string(),
	/** Vimeo video ID or URL */
	id: z.string(),
	/** Custom poster image URL */
	poster: httpUrl.optional(),
	/** Poster quality */
	posterQuality: z.enum(["max", "high", "default", "low"]).optional(),
	/** Vimeo player parameters */
	params: z.string().optional(),
	/** Accessible label for the play button */
	playlabel: z.string().optional(),
});

export type VimeoBlock = z.infer<typeof vimeoBlockSchema>;

/**
 * Twitter/X tweet embed block
 * @see https://astro-embed.netlify.app/components/twitter/
 */
export const tweetBlockSchema = z.object({
	_type: z.literal("tweet"),
	_key: z.string(),
	/** Tweet URL or ID */
	id: z.string(),
	/** Color theme */
	theme: z.enum(["light", "dark"]).optional(),
});

export type TweetBlock = z.infer<typeof tweetBlockSchema>;

/**
 * Bluesky post embed block
 * @see https://astro-embed.netlify.app/components/bluesky/
 */
export const blueskyBlockSchema = z.object({
	_type: z.literal("bluesky"),
	_key: z.string(),
	/** Bluesky post URL or AT URI */
	id: z.string(),
});

export type BlueskyBlock = z.infer<typeof blueskyBlockSchema>;

/**
 * Mastodon post embed block
 * @see https://astro-embed.netlify.app/components/mastodon/
 */
export const mastodonBlockSchema = z.object({
	_type: z.literal("mastodon"),
	_key: z.string(),
	/** Mastodon post URL */
	id: z.string(),
});

export type MastodonBlock = z.infer<typeof mastodonBlockSchema>;

/**
 * Link preview / Open Graph embed block
 * @see https://astro-embed.netlify.app/components/link-preview/
 */
export const linkPreviewBlockSchema = z.object({
	_type: z.literal("linkPreview"),
	_key: z.string(),
	/** URL to fetch Open Graph data from */
	id: httpUrl,
	/** Hide media (image/video) even if present in OG data */
	hideMedia: z.boolean().optional(),
});

export type LinkPreviewBlock = z.infer<typeof linkPreviewBlockSchema>;

/**
 * GitHub Gist embed block
 * @see https://astro-embed.netlify.app/components/gist/
 */
export const gistBlockSchema = z.object({
	_type: z.literal("gist"),
	_key: z.string(),
	/** Gist URL */
	id: httpUrl,
	/** Specific file to show (case-sensitive) */
	file: z.string().optional(),
});

export type GistBlock = z.infer<typeof gistBlockSchema>;

/**
 * Union of all embed block types
 */
export const embedBlockSchema = z.discriminatedUnion("_type", [
	youtubeBlockSchema,
	vimeoBlockSchema,
	tweetBlockSchema,
	blueskyBlockSchema,
	mastodonBlockSchema,
	linkPreviewBlockSchema,
	gistBlockSchema,
]);

export type EmbedBlock = z.infer<typeof embedBlockSchema>;

/**
 * Block type names for use in plugin registration
 */
export const EMBED_BLOCK_TYPES = [
	"youtube",
	"vimeo",
	"tweet",
	"bluesky",
	"mastodon",
	"linkPreview",
	"gist",
] as const;

export type EmbedBlockType = (typeof EMBED_BLOCK_TYPES)[number];
