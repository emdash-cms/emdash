/**
 * Shared URL validation and transformation utilities
 */

const DEFAULT_REDIRECT = "/_emdash/admin";
const LEADING_SLASHES = /^\/+/;

export interface ContentUrlOptions {
	locale?: string | null;
	i18n?: {
		defaultLocale: string;
		locales: string[];
		prefixDefaultLocale?: boolean;
	};
	/** Entry id used to resolve `{id}` tokens in the pattern. */
	id?: string;
	/** Publish date used to resolve `{year}`/`{month}`/... tokens in the pattern. */
	date?: string | null;
}

/**
 * Sanitize a redirect URL to prevent open-redirect and javascript: XSS attacks.
 *
 * Only allows relative paths starting with `/`. Rejects protocol-relative
 * URLs (`//evil.com`), backslash tricks (`/\evil.com`), and non-path schemes
 * like `javascript:`.
 *
 * Returns the default admin URL when the input is unsafe.
 */
export function sanitizeRedirectUrl(raw: string): string {
	if (raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\")) {
		return raw;
	}
	return DEFAULT_REDIRECT;
}

const DATE_TOKEN = /\{(year|month|day|hour|minute|second)\}/g;
// SQLite-style datetime without timezone info; stored values are UTC.
const OFFSETLESS_DATETIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;
const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Substitute WordPress-style date tokens from a publish date (zero-padded).
 * Tokens are left untouched when no valid date is available. Kept in sync with
 * the core `interpolateUrlPattern` resolver used for sitemap/canonical URLs.
 */
function applyDateTokens(path: string, date?: string | null): string {
	if (date == null) return path;
	const offsetless = OFFSETLESS_DATETIME.exec(date);
	const d = new Date(offsetless ? `${offsetless[1]}T${offsetless[2]}Z` : date);
	if (Number.isNaN(d.getTime())) return path;
	const parts: Record<string, string> = {
		year: String(d.getUTCFullYear()),
		month: pad2(d.getUTCMonth() + 1),
		day: pad2(d.getUTCDate()),
		hour: pad2(d.getUTCHours()),
		minute: pad2(d.getUTCMinutes()),
		second: pad2(d.getUTCSeconds()),
	};
	return path.replace(DATE_TOKEN, (match, key: string) => parts[key] ?? match);
}

/**
 * Build a public content URL from collection metadata and slug.
 *
 * Uses the collection's `urlPattern` when available (e.g. `/blog/{slug}`),
 * otherwise falls back to `/{collection}/{slug}`. Also resolves the date
 * tokens `{year}`/`{month}`/`{day}`/`{hour}`/`{minute}`/`{second}` from the
 * entry's publish `date` (for WordPress-style permalinks). Leading slashes are
 * stripped from the slug to prevent protocol-relative URLs.
 */
export function contentUrl(
	collection: string,
	slug: string,
	urlPattern?: string,
	options?: ContentUrlOptions,
): string {
	const safe = slug.replace(LEADING_SLASHES, "");
	// Date tokens resolve against the pattern before the slug is inserted, so
	// a slug that happens to contain `{year}`-style text stays untouched.
	let pattern = urlPattern && applyDateTokens(urlPattern, options?.date);
	if (pattern && options?.id) pattern = pattern.replaceAll("{id}", options.id);
	const path = pattern ? pattern.replaceAll("{slug}", safe) : `/${collection}/${safe}`;
	const { locale, i18n } = options ?? {};
	const shouldPrefix =
		locale && i18n && (locale !== i18n.defaultLocale || i18n.prefixDefaultLocale === true);

	return shouldPrefix ? `/${locale}/${path.replace(LEADING_SLASHES, "")}` : path;
}

/** Matches http:// or https:// URLs */
export const SAFE_URL_RE = /^https?:\/\//i;

/** Returns true if the URL uses a safe scheme (http/https) */
export function isSafeUrl(url: string): boolean {
	return SAFE_URL_RE.test(url);
}

/**
 * Build an icon URL with a width query param, or return null for unsafe URLs.
 * Validates the URL scheme and appends `?w=<width>` for image resizing.
 */
export function safeIconUrl(url: string, width: number): string | null {
	if (!SAFE_URL_RE.test(url)) return null;
	try {
		const u = new URL(url);
		u.searchParams.set("w", String(width));
		return u.href;
	} catch {
		return null;
	}
}
