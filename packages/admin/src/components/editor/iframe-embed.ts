/**
 * Reads what an author pastes into an iframe block's Code tab (an embed code
 * or a link) and writes the canonical embed code back.
 */

export interface IframeEmbed {
	/** An absolute https URL. */
	src: string;
	title?: string;
	width?: number;
	height?: number;
	allow?: string;
	allowFullscreen?: boolean;
}

export type IframeParseResult =
	| { ok: true; embed: IframeEmbed | null }
	| { ok: false; reason: "no-iframe" | "not-https" };

/** Permissions that video and map players need. The site renders only these. */
export const IFRAME_ALLOWED_FEATURES: ReadonlySet<string> = new Set([
	"accelerometer",
	"autoplay",
	"clipboard-write",
	"encrypted-media",
	"fullscreen",
	"gyroscope",
	"picture-in-picture",
	"web-share",
]);

const PLAYER_SIZE = { width: 560, height: 315 };
const YOUTUBE_ALLOW =
	"accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
const VIMEO_ALLOW = "autoplay; fullscreen; picture-in-picture";
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const YOUTUBE_ID_RE = /^[\w-]{11}$/;
const YOUTUBE_PATH_RE = /^\/(?:shorts|live)\/([\w-]{11})\/?$/;
const VIMEO_PATH_RE = /^\/(\d+)\/?$/;
const WHOLE_NUMBER_RE = /^\d+$/;
const WHITESPACE_RE = /\s+/;
const MARKUP_RE = /[&"<>]/g;
const ENTITIES: Record<string, string> = { "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" };

/** The URL, when the value is an absolute https URL. */
export function httpsUrl(value: string | null | undefined): URL | undefined {
	try {
		const url = new URL(value ?? "");
		return url.protocol === "https:" ? url : undefined;
	} catch {
		return undefined;
	}
}

function dimension(value: string | null): number | undefined {
	const number = value && WHOLE_NUMBER_RE.test(value) ? Number(value) : 0;
	return isDimension(number) ? number : undefined;
}

/**
 * Keep only the permissions an embedded page may have, granted to its own
 * origin. A directive whose allowlist is `'none'` grants nothing, so it's dropped.
 */
export function iframeAllow(value: string | null | undefined): string {
	return (value ?? "")
		.split(";")
		.map((directive) => directive.trim().split(WHITESPACE_RE))
		.filter(
			([feature = "", ...origins]) =>
				IFRAME_ALLOWED_FEATURES.has(feature) && !origins.includes("'none'"),
		)
		.map(([feature]) => feature)
		.join("; ");
}

function isDimension(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10_000;
}

const isString = (value: unknown) => typeof value === "string";

const IFRAME_BLOCK_FIELDS = new Map<string, (value: unknown) => boolean>([
	["_type", () => true],
	["_key", () => true],
	["src", isString],
	["title", isString],
	["width", isDimension],
	["height", isDimension],
	["allow", isString],
	["allowFullscreen", (value) => typeof value === "boolean"],
]);

/**
 * Whether a Portable Text `iframe` block is the built-in kind. One with other
 * fields, or with values of other types, belongs to a plugin.
 */
export function isBuiltInIframeBlock(block: object): boolean {
	return (
		"src" in block &&
		typeof block.src === "string" &&
		Object.entries(block).every(
			([key, value]) => value === undefined || (IFRAME_BLOCK_FIELDS.get(key)?.(value) ?? false),
		)
	);
}

/** Read an iframe block's saved fields, keeping only valid ones. */
export function iframeEmbedFromAttrs(attrs: object): IframeEmbed {
	const {
		src,
		title,
		width,
		height,
		allow,
		allowFullscreen,
	}: {
		src?: unknown;
		title?: unknown;
		width?: unknown;
		height?: unknown;
		allow?: unknown;
		allowFullscreen?: unknown;
	} = attrs;
	const embed: IframeEmbed = { src: typeof src === "string" ? src : "" };
	if (typeof title === "string" && title) embed.title = title;
	if (isDimension(width)) embed.width = width;
	if (isDimension(height)) embed.height = height;
	if (typeof allow === "string" && allow) embed.allow = allow;
	if (allowFullscreen === true) embed.allowFullscreen = true;
	return embed;
}

/** The node attributes for an embed, with absent fields cleared. */
export function iframeEmbedAttrs(embed: IframeEmbed | null) {
	return {
		src: embed?.src ?? "",
		title: embed?.title ?? "",
		width: embed?.width ?? null,
		height: embed?.height ?? null,
		allow: embed?.allow ?? "",
		allowFullscreen: embed?.allowFullscreen === true,
	};
}

/** Turn a YouTube or Vimeo watch link into its player. */
function playerEmbed(url: URL): IframeEmbed | undefined {
	const host = url.hostname;
	const youtubeId =
		host === "youtu.be"
			? url.pathname.slice(1)
			: YOUTUBE_HOSTS.has(host)
				? url.pathname === "/watch"
					? url.searchParams.get("v")
					: YOUTUBE_PATH_RE.exec(url.pathname)?.[1]
				: undefined;
	if (youtubeId && YOUTUBE_ID_RE.test(youtubeId)) {
		return {
			src: `https://www.youtube.com/embed/${youtubeId}`,
			...PLAYER_SIZE,
			allow: YOUTUBE_ALLOW,
			allowFullscreen: true,
		};
	}
	const vimeoId =
		host === "vimeo.com" || host === "www.vimeo.com" ? VIMEO_PATH_RE.exec(url.pathname)?.[1] : null;
	if (vimeoId) {
		return {
			src: `https://player.vimeo.com/video/${vimeoId}`,
			...PLAYER_SIZE,
			allow: VIMEO_ALLOW,
			allowFullscreen: true,
		};
	}
	return undefined;
}

/**
 * Parse an embed code or a link. Blank text clears the embed. Other
 * attributes of a pasted iframe are dropped.
 */
export function parseIframeInput(text: string): IframeParseResult {
	const input = text.trim();
	if (!input) return { ok: true, embed: null };
	if (!input.startsWith("<")) {
		const url = httpsUrl(input);
		if (!url) return { ok: false, reason: "not-https" };
		return { ok: true, embed: playerEmbed(url) ?? { src: url.href } };
	}
	const frame = new DOMParser().parseFromString(input, "text/html").querySelector("iframe");
	if (!frame) return { ok: false, reason: "no-iframe" };
	const url = httpsUrl(frame.getAttribute("src"));
	if (!url) return { ok: false, reason: "not-https" };
	const embed: IframeEmbed = { src: url.href };
	const title = frame.getAttribute("title")?.trim();
	const width = dimension(frame.getAttribute("width"));
	const height = dimension(frame.getAttribute("height"));
	const allow = iframeAllow(frame.getAttribute("allow"));
	if (title) embed.title = title;
	if (width) embed.width = width;
	if (height) embed.height = height;
	if (allow) embed.allow = allow;
	if (frame.hasAttribute("allowfullscreen")) embed.allowFullscreen = true;
	return { ok: true, embed };
}

/** The canonical embed code for what is saved. */
export function iframeEmbedToCode(embed: IframeEmbed): string {
	const escape = (value: string) => value.replace(MARKUP_RE, (char) => ENTITIES[char] ?? char);
	const attributes = [
		`src="${escape(embed.src)}"`,
		embed.title && `title="${escape(embed.title)}"`,
		embed.width && `width="${embed.width}"`,
		embed.height && `height="${embed.height}"`,
		embed.allow && `allow="${escape(embed.allow)}"`,
		embed.allowFullscreen && "allowfullscreen",
	].filter(Boolean);
	return `<iframe ${attributes.join(" ")}></iframe>`;
}
