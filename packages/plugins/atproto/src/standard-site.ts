/**
 * standard.site record builders
 *
 * Builds site.standard.publication and site.standard.document records
 * from EmDash content.
 */

// ── Types ───────────────────────────────────────────────────────

export interface StandardPublication {
	$type: "site.standard.publication";
	url: string;
	name: string;
	description?: string;
}

export interface StandardDocument {
	$type: "site.standard.document";
	/** AT-URI of the publication record, or HTTPS URL for loose documents */
	site: string;
	title: string;
	publishedAt: string;
	/** Path component -- combined with publication URL to form canonical URL */
	path?: string;
	description?: string;
	textContent?: string;
	tags?: string[];
	updatedAt?: string;
	coverImage?: BlobRefLike;
	/** Strong reference to a Bluesky post for off-platform comments */
	bskyPostRef?: { uri: string; cid: string };
}

interface BlobRefLike {
	$type: "blob";
	ref: { $link: string };
	mimeType: string;
	size: number;
}

// ── Builders ────────────────────────────────────────────────────

/**
 * Build a site.standard.publication record.
 */
export function buildPublication(
	siteUrl: string,
	siteName: string,
	description?: string,
): StandardPublication {
	return {
		$type: "site.standard.publication",
		url: stripTrailingSlash(siteUrl),
		name: siteName,
		...(description ? { description } : {}),
	};
}

/**
 * Build a site.standard.document record from EmDash content.
 */
export function buildDocument(opts: {
	publicationUri: string;
	collection?: string;
	content: Record<string, unknown>;
	coverImageBlob?: BlobRefLike;
	bskyPostRef?: { uri: string; cid: string };
}): StandardDocument {
	const { publicationUri, collection, content, coverImageBlob, bskyPostRef } = opts;

	const title = getContentString(content, "title") || "Untitled";
	const description =
		getContentString(content, "excerpt") || getContentString(content, "description");
	const publishedAt =
		getString(content, "publishedAt") ||
		getString(content, "published_at") ||
		new Date().toISOString();
	const updatedAt = getString(content, "updatedAt") || getString(content, "updated_at");
	const tags = extractTags(content);

	const doc: StandardDocument = {
		$type: "site.standard.document",
		site: publicationUri,
		title,
		publishedAt,
	};

	const path = buildContentPath(collection, content);
	if (path) doc.path = path;

	if (description) {
		doc.description = description;
	}

	const plainText = extractPlainText(content);
	if (plainText) {
		doc.textContent = plainText;
	}

	if (tags.length > 0) {
		doc.tags = tags;
	}

	if (updatedAt) {
		doc.updatedAt = updatedAt;
	}

	if (coverImageBlob) {
		doc.coverImage = coverImageBlob;
	}

	if (bskyPostRef) {
		doc.bskyPostRef = bskyPostRef;
	}

	return doc;
}

// ── Helpers ─────────────────────────────────────────────────────

function stripTrailingSlash(url: string): string {
	return url.endsWith("/") ? url.slice(0, -1) : url;
}

// Pre-compiled regexes
const HTML_TAG_RE = /<[^>]+>/g;
const NBSP_RE = /&nbsp;/g;
const AMP_RE = /&amp;/g;
const LT_RE = /&lt;/g;
const GT_RE = /&gt;/g;
const QUOT_RE = /&quot;/g;
const APOS_RE = /&#39;/g;
const WHITESPACE_RE = /\s+/g;
const HASH_PREFIX_RE = /^#/;
const MAX_TEXT_CONTENT_LENGTH = 10_000;

function getString(obj: Record<string, unknown>, key: string): string | undefined {
	const v = obj[key];
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

function getContentData(content: Record<string, unknown>): Record<string, unknown> {
	return content.data && typeof content.data === "object"
		? (content.data as Record<string, unknown>)
		: {};
}

function getContentString(content: Record<string, unknown>, key: string): string | undefined {
	return getString(content, key) || getString(getContentData(content), key);
}

export function buildContentPath(
	collection: string | undefined,
	content: Record<string, unknown>,
): string | undefined {
	const slug = getString(content, "slug");
	if (!slug) return undefined;

	if (!collection || collection === "pages") return `/${slug}`;
	return `/${collection}/${slug}`;
}

/**
 * Extract tags from content. Handles both string arrays and
 * tag objects with a name property.
 */
function extractTags(content: Record<string, unknown>): string[] {
	const raw = content.tags || getContentData(content).tags;
	if (!Array.isArray(raw)) return [];

	const tags: string[] = [];
	for (const item of raw) {
		if (typeof item === "string") {
			tags.push(item.replace(HASH_PREFIX_RE, ""));
		} else if (
			typeof item === "object" &&
			item !== null &&
			"name" in item &&
			typeof (item as Record<string, unknown>).name === "string"
		) {
			tags.push(((item as Record<string, unknown>).name as string).replace(HASH_PREFIX_RE, ""));
		}
	}
	return tags;
}

/**
 * Extract plain text from content for the textContent field.
 * Strips HTML tags and collapses whitespace.
 */
export function extractPlainText(content: Record<string, unknown>): string | undefined {
	// Try common content field names
	const body =
		getContentString(content, "body") ||
		getContentString(content, "content") ||
		getContentString(content, "text");

	if (!body) return undefined;

	// Strip HTML tags (simple -- not a full parser, but sufficient for plain text extraction).
	// Decode &amp; last to avoid double-decoding (e.g. &amp;lt; -> &lt; -> <).
	let text = body
		.replace(HTML_TAG_RE, " ")
		.replace(NBSP_RE, " ")
		.replace(LT_RE, "<")
		.replace(GT_RE, ">")
		.replace(QUOT_RE, '"')
		.replace(APOS_RE, "'")
		.replace(AMP_RE, "&")
		.replace(WHITESPACE_RE, " ")
		.trim();

	if (!text) return undefined;

	// Truncate to 10,000 chars to avoid exceeding PDS record size limits (~100KB)
	if (text.length > MAX_TEXT_CONTENT_LENGTH) {
		text = text.slice(0, MAX_TEXT_CONTENT_LENGTH - 1) + "\u2026";
	}

	return text;
}
