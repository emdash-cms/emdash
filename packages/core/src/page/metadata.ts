/**
 * Page metadata collection and rendering
 *
 * Collects typed metadata contributions from plugins via the page:metadata hook,
 * validates them, and resolves them into a deduplicated structure ready to render.
 */

import type { PageMetadataContribution, PageMetadataLinkRel } from "../plugins/types.js";

// ── Resolved output ─────────────────────────────────────────────

export interface ResolvedPageMetadata {
	meta: Array<{ name: string; content: string }>;
	properties: Array<{ property: string; content: string }>;
	links: Array<{
		rel: PageMetadataLinkRel;
		href: string;
		hreflang?: string;
	}>;
	jsonld: Array<{ id?: string; json: string }>;
}

interface RenderPageMetadataOptions {
	includeJsonLd?: boolean;
}

// ── Validation ──────────────────────────────────────────────────

/** Schemes safe for use in link href attributes */
const SAFE_HREF_RE = /^(https?|at):\/\//i;
const HTML_ESCAPE_MAP: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};
const HTML_ESCAPE_RE = /[&<>"']/g;

/** Escape a string for safe use in an HTML attribute value */
export function escapeHtmlAttr(value: string): string {
	return value.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}

/** Validate that a URL uses a safe scheme (http, https, at) */
function isSafeHref(url: string): boolean {
	return SAFE_HREF_RE.test(url);
}

// ── JSON-LD serialization ───────────────────────────────────────

const JSONLD_LT_RE = /</g;
const JSONLD_GT_RE = />/g;
const JSONLD_U2028_RE = /\u2028/g;
const JSONLD_U2029_RE = /\u2029/g;

/**
 * Safely serialize a value for embedding in a <script type="application/ld+json"> tag.
 *
 * Plain JSON.stringify is not sufficient because:
 * - "</script>" in a nested string breaks out of the script tag
 * - "<!--" can open an HTML comment
 * - U+2028/U+2029 are line terminators in some JS engines
 */
export function safeJsonLdSerialize(value: unknown): string {
	return JSON.stringify(value)
		.replace(JSONLD_LT_RE, "\\u003c")
		.replace(JSONLD_GT_RE, "\\u003e")
		.replace(JSONLD_U2028_RE, "\\u2028")
		.replace(JSONLD_U2029_RE, "\\u2029");
}

export async function createSha256CspHash(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	const bytes = new Uint8Array(digest);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return `sha256-${btoa(binary)}`;
}

// ── Merge / dedupe ──────────────────────────────────────────────

/**
 * Resolve a flat list of contributions into deduplicated metadata.
 * First contribution wins for any given dedupe key.
 */
export function resolvePageMetadata(
	contributions: PageMetadataContribution[],
): ResolvedPageMetadata {
	const result: ResolvedPageMetadata = {
		meta: [],
		properties: [],
		links: [],
		jsonld: [],
	};

	const seenMeta = new Set<string>();
	const seenProperties = new Set<string>();
	const seenLinks = new Set<string>();
	const seenJsonLd = new Set<string>();

	for (const c of contributions) {
		switch (c.kind) {
			case "meta": {
				const dedupeKey = c.key ?? c.name;
				if (seenMeta.has(dedupeKey)) continue;
				seenMeta.add(dedupeKey);
				result.meta.push({ name: c.name, content: c.content });
				break;
			}
			case "property": {
				const dedupeKey = c.key ?? c.property;
				if (seenProperties.has(dedupeKey)) continue;
				seenProperties.add(dedupeKey);
				result.properties.push({
					property: c.property,
					content: c.content,
				});
				break;
			}
			case "link": {
				if (!isSafeHref(c.href)) {
					if (import.meta.env?.DEV) {
						console.warn(
							`[page:metadata] Rejected link contribution with unsafe href scheme: ${c.href}`,
						);
					}
					continue;
				}
				if (c.rel === "canonical") {
					if (seenLinks.has("canonical")) continue;
					seenLinks.add("canonical");
				} else {
					const dedupeKey = c.key ?? c.hreflang ?? c.href;
					if (seenLinks.has(dedupeKey)) continue;
					seenLinks.add(dedupeKey);
				}
				result.links.push({
					rel: c.rel,
					href: c.href,
					...(c.hreflang && { hreflang: c.hreflang }),
				});
				break;
			}
			case "jsonld": {
				if (c.id) {
					if (seenJsonLd.has(c.id)) continue;
					seenJsonLd.add(c.id);
				}
				result.jsonld.push({
					id: c.id,
					json: safeJsonLdSerialize(c.graph),
				});
				break;
			}
			default:
				// Unknown contribution kind -- skip silently at runtime.
				// TypeScript catches this at compile time for typed callers,
				// but sandboxed plugins may return unexpected shapes.
				break;
		}
	}

	return result;
}

// ── HTML rendering ──────────────────────────────────────────────

/** Render resolved metadata to an HTML string for embedding in <head> */
export function renderPageMetadata(
	metadata: ResolvedPageMetadata,
	options: RenderPageMetadataOptions = {},
): string {
	const parts: string[] = [];
	const includeJsonLd = options.includeJsonLd ?? true;

	for (const m of metadata.meta) {
		parts.push(`<meta name="${escapeHtmlAttr(m.name)}" content="${escapeHtmlAttr(m.content)}">`);
	}

	for (const p of metadata.properties) {
		parts.push(
			`<meta property="${escapeHtmlAttr(p.property)}" content="${escapeHtmlAttr(p.content)}">`,
		);
	}

	for (const l of metadata.links) {
		let tag = `<link rel="${escapeHtmlAttr(l.rel)}" href="${escapeHtmlAttr(l.href)}"`;
		if (l.hreflang) {
			tag += ` hreflang="${escapeHtmlAttr(l.hreflang)}"`;
		}
		tag += ">";
		parts.push(tag);
	}

	if (includeJsonLd) {
		for (const j of metadata.jsonld) {
			parts.push(`<script type="application/ld+json">${j.json}</script>`);
		}
	}

	return parts.join("\n");
}
