/**
 * Embeds Plugin for EmDash CMS
 *
 * Provides Portable Text block types for embedding external content:
 * - YouTube videos
 * - Vimeo videos
 * - Twitter/X tweets
 * - Bluesky posts
 * - Mastodon posts
 * - Link previews (Open Graph)
 * - GitHub Gists
 *
 * Uses astro-embed components, except for Bluesky posts, which use Bluesky's
 * own embed script.
 *
 * @example
 * ```typescript
 * // live.config.ts
 * import { embedsPlugin } from "@emdash-cms/plugin-embeds";
 *
 * export default defineConfig({
 *   plugins: [embedsPlugin()],
 * });
 * ```
 *
 * Embed components are automatically registered with PortableText when
 * the plugin is enabled. No manual component wiring needed!
 *
 * If you need to customize rendering, you can still override specific types:
 *
 * @example
 * ```astro
 * <PortableText
 *   value={content}
 *   components={{
 *     types: {
 *       youtube: MyCustomYouTube, // Override just this one
 *     },
 *   }}
 * />
 * ```
 */

import type { Element } from "@emdash-cms/blocks";
import type { PluginDescriptor, ResolvedPlugin } from "emdash";
import { definePlugin } from "emdash";

import { EMBED_BLOCK_TYPES } from "./schemas.js";

/** Rich metadata for each embed block type */
const EMBED_BLOCK_META: Record<
	string,
	{
		label: string;
		icon?: string;
		description?: string;
		placeholder?: string;
		fields?: Element[];
	}
> = {
	youtube: {
		label: "YouTube Video",
		icon: "video",
		placeholder: "Paste YouTube URL...",
		fields: [
			{
				type: "text_input",
				action_id: "id",
				label: "YouTube URL",
				placeholder: "https://youtube.com/watch?v=...",
			},
			{ type: "text_input", action_id: "title", label: "Title" },
			{ type: "text_input", action_id: "poster", label: "Poster Image URL" },
			{
				type: "text_input",
				action_id: "params",
				label: "Player Parameters",
				placeholder: "start=57&end=75",
			},
		],
	},
	vimeo: {
		label: "Vimeo Video",
		icon: "video",
		placeholder: "Paste Vimeo URL...",
		fields: [
			{
				type: "text_input",
				action_id: "id",
				label: "Vimeo URL",
				placeholder: "https://vimeo.com/...",
			},
			{ type: "text_input", action_id: "poster", label: "Poster Image URL" },
			{ type: "text_input", action_id: "params", label: "Player Parameters" },
		],
	},
	tweet: { label: "Tweet (X)", icon: "link", placeholder: "Paste tweet URL..." },
	bluesky: { label: "Bluesky Post", icon: "link", placeholder: "Paste Bluesky post URL..." },
	mastodon: { label: "Mastodon Post", icon: "link", placeholder: "Paste Mastodon post URL..." },
	linkPreview: {
		label: "Link Preview",
		icon: "link-external",
		placeholder: "Paste any URL...",
	},
	gist: {
		label: "GitHub Gist",
		icon: "code",
		placeholder: "Paste Gist URL...",
		fields: [
			{
				type: "text_input",
				action_id: "id",
				label: "Gist URL",
				placeholder: "https://gist.github.com/.../...",
			},
			{
				type: "text_input",
				action_id: "file",
				label: "Specific File",
				placeholder: "Optional: filename to show",
			},
		],
	},
};

export interface EmbedsPluginOptions {
	/**
	 * Which embed types to enable.
	 * Defaults to all types.
	 */
	types?: Array<(typeof EMBED_BLOCK_TYPES)[number]>;
}

/**
 * Create the embeds plugin descriptor
 */
export function embedsPlugin(
	options: EmbedsPluginOptions = {},
): PluginDescriptor<EmbedsPluginOptions> {
	return {
		id: "embeds",
		version: "0.0.1",
		entrypoint: "@emdash-cms/plugin-embeds",
		componentsEntry: "@emdash-cms/plugin-embeds/astro",
		options,
	};
}

/**
 * Create the embeds plugin
 */
export function createPlugin(options: EmbedsPluginOptions = {}): ResolvedPlugin {
	const _enabledTypes = options.types ?? [...EMBED_BLOCK_TYPES];

	return definePlugin({
		id: "embeds",
		version: "0.0.1",

		// This plugin only provides block types - no server-side capabilities needed
		capabilities: [],

		admin: {
			portableTextBlocks: _enabledTypes.map((type) => {
				const meta = EMBED_BLOCK_META[type];
				return {
					type,
					label: meta?.label ?? type,
					icon: meta?.icon,
					description: meta?.description,
					placeholder: meta?.placeholder,
					fields: meta?.fields,
				};
			}),
		},
	});
}

// Re-export schemas for consumers who need them
export * from "./schemas.js";

export default createPlugin;

// Re-export the enabled types for the plugin to use
export { EMBED_BLOCK_TYPES };
