import { encodeBase64, decodeBase64 } from "../../utils/base64.js";

/**
 * Hard cap on cursor length. Cursors we issue are short JSON-in-base64
 * blobs; a real cursor is well under 200 chars. This guards against
 * malicious callers passing megabyte-sized strings to force the base64
 * decoder to allocate (decodeBase64 is O(N) in input size). The MCP and
 * REST schemas also clamp at 2048 — this 4096 cap is a defense-in-depth
 * floor inside the repository helpers.
 */
const MAX_CURSOR_LENGTH = 4096;

export interface CreateContentInput {
	type: string;
	slug?: string | null;
	data: Record<string, unknown>;
	status?: string;
	authorId?: string;
	primaryBylineId?: string | null;
	locale?: string;
	translationOf?: string;
	publishedAt?: string | null;
	/** Override created_at (ISO 8601). Used by importers to preserve original dates. */
	createdAt?: string | null;
}

export interface UpdateContentInput {
	data?: Record<string, unknown>;
	status?: string;
	slug?: string | null;
	publishedAt?: string | null;
	scheduledAt?: string | null;
	authorId?: string | null;
	primaryBylineId?: string | null;
}

/** SEO fields for content items */
export interface ContentSeo {
	title: string | null;
	description: string | null;
	image: string | null;
	canonical: string | null;
	noIndex: boolean;
}

/** Input for updating SEO fields on content */
export interface ContentSeoInput {
	title?: string | null;
	description?: string | null;
	image?: string | null;
	canonical?: string | null;
	noIndex?: boolean;
}

export interface BylineSummary {
	id: string;
	slug: string;
	displayName: string;
	bio: string | null;
	avatarMediaId: string | null;
	/**
	 * The avatar media's storage key, folded in by a LEFT JOIN on the
	 * `media` table during content byline hydration. Non-null only when the
	 * byline has an avatar AND was loaded through the content-credit hydration
	 * path (`getContentBylines` / `getContentBylinesMany`, i.e. the
	 * `entry.data.bylines` populated by `getEmDashCollection` / `getEmDashEntry`).
	 * The plain byline finders (`findById`, `findBySlug`, …) leave it null.
	 *
	 * Lets list pages build a direct storage URL for an author avatar without a
	 * per-byline `MediaRepository.findById`, avoiding an N+1 when many distinct
	 * authors appear on one page.
	 *
	 * Optional so adding it is a non-breaking change for existing code that
	 * constructs a `BylineSummary` literal; the repositories always populate it
	 * (to `null` when there's no avatar or no media join).
	 */
	avatarStorageKey?: string | null;
	/** Avatar media alt text, from the same media join. Null when not joined. */
	avatarAlt?: string | null;
	websiteUrl: string | null;
	userId: string | null;
	isGuest: boolean;
	createdAt: string;
	updatedAt: string;
	/**
	 * Locale this byline row is presented in. Added by migration 040.
	 * `(slug, locale)` is unique; a single slug can repeat across locales.
	 */
	locale: string;
	/**
	 * Shared across translations of the same byline. Added by migration 040.
	 * `_emdash_content_bylines.byline_id` and `ec_*.primary_byline_id` store
	 * this value, so a credit spans every locale variant of a byline.
	 * Nullable in storage for backwards compatibility; new rows always
	 * populate it.
	 */
	translationGroup: string | null;
}

export interface ContentBylineCredit {
	byline: BylineSummary;
	sortOrder: number;
	roleLabel: string | null;
	/** Whether this credit was explicitly assigned or inferred from authorId */
	source?: "explicit" | "inferred";
}

export interface FindManyOptions {
	where?: {
		status?: string;
		authorId?: string;
		locale?: string;
		/** Case-insensitive substring to match against `searchColumns`. */
		q?: string;
		/**
		 * Columns the `q` substring filter is applied to (OR'd together).
		 * Resolved by the handler from the collection's display fields so the
		 * repository stays generic. Each name is validated as a SQL identifier.
		 */
		searchColumns?: string[];
	};
	orderBy?: {
		field: string;
		direction: "asc" | "desc";
	};
	limit?: number;
	cursor?: string; // Base64-encoded JSON: {orderValue: string, id: string}
}

export interface FindManyResult<T> {
	items: T[];
	nextCursor?: string; // Base64-encoded JSON: {orderValue: string, id: string}
	/**
	 * Total number of rows matching the where clause (ignoring pagination).
	 * Optional because not every caller needs it; repositories that compute
	 * it should set it so the UI can render a stable pagination denominator.
	 */
	total?: number;
}

/** Encode a cursor from order value + id */
export function encodeCursor(orderValue: string, id: string): string {
	return encodeBase64(JSON.stringify({ orderValue, id }));
}

/**
 * Thrown when a pagination cursor cannot be decoded.
 *
 * Repository callers should let this propagate; handler catch blocks
 * map it to a structured `INVALID_CURSOR` error so client pagination
 * bugs surface immediately rather than silently re-fetching the first
 * page.
 */
export class InvalidCursorError extends Error {
	constructor(cursor: string) {
		const display = cursor.length > 50 ? `${cursor.slice(0, 47)}...` : cursor;
		super(`Invalid pagination cursor: ${display}`);
		this.name = "InvalidCursorError";
	}
}

/**
 * Decode a cursor to order value + id.
 *
 * Throws `InvalidCursorError` if the cursor is empty, not valid base64,
 * not valid JSON, or doesn't contain string `orderValue` and `id` fields.
 */
export function decodeCursor(cursor: string): { orderValue: string; id: string } {
	if (!cursor) throw new InvalidCursorError(cursor);
	if (cursor.length > MAX_CURSOR_LENGTH) throw new InvalidCursorError(cursor);
	let parsed: unknown;
	try {
		parsed = JSON.parse(decodeBase64(cursor));
	} catch {
		throw new InvalidCursorError(cursor);
	}
	if (parsed === null || typeof parsed !== "object") {
		throw new InvalidCursorError(cursor);
	}
	const candidate = parsed as { orderValue?: unknown; id?: unknown };
	if (typeof candidate.orderValue !== "string" || typeof candidate.id !== "string") {
		throw new InvalidCursorError(cursor);
	}
	return { orderValue: candidate.orderValue, id: candidate.id };
}

export interface ContentItem {
	id: string;
	type: string;
	slug: string | null;
	status: string;
	data: Record<string, unknown>;
	authorId: string | null;
	primaryBylineId: string | null;
	byline?: BylineSummary | null;
	bylines?: ContentBylineCredit[];
	createdAt: string;
	updatedAt: string;
	publishedAt: string | null;
	scheduledAt: string | null;
	liveRevisionId: string | null;
	draftRevisionId: string | null;
	version: number;
	locale: string | null;
	translationGroup: string | null;
	/** SEO metadata — only populated for collections with `has_seo` enabled */
	seo?: ContentSeo;
	/**
	 * For collections that support `revisions`: when a draft revision exists,
	 * `data` reflects the unsaved draft and `liveData` carries the currently-
	 * published values. When no draft exists, `liveData` is undefined.
	 *
	 * Hydrated by `EmDashRuntime.hydrateDraftData()` — repositories themselves
	 * never set this field; it's purely a runtime-overlay concept that gives
	 * agents a clear picture of "draft vs. live" without re-fetching the
	 * revision history.
	 */
	liveData?: Record<string, unknown>;
}

export class EmDashValidationError extends Error {
	constructor(
		message: string,
		public details?: unknown,
	) {
		super(message);
		this.name = "EmDashValidationError";
	}
}
