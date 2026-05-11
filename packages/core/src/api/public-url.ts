/**
 * Public URL helpers for reverse-proxy deployments.
 *
 * Behind a TLS-terminating proxy the internal request URL
 * (`http://localhost:4321`) differs from the browser-facing origin
 * (`https://mysite.example.com`). These pure helpers resolve the
 * correct public origin from config, falling back to the request URL.
 *
 * Workers-safe: no Node.js imports.
 */

/** Minimal config shape — avoids importing the full EmDashConfig type tree. */
interface SiteUrlConfig {
	siteUrl?: string;
}

/**
 * Resolve siteUrl from runtime environment variables.
 *
 * Uses process.env (not import.meta.env) because Vite statically replaces
 * import.meta.env at build time, baking out any env vars not present during
 * the build. Container deployments set env vars at runtime, so we must read
 * process.env which Vite leaves untouched.
 *
 * On Cloudflare Workers process.env is unavailable (returns undefined),
 * so the fallback chain continues to url.origin.
 *
 * Caches after first call.
 */
let _envSiteUrl: string | undefined | null = null;

/** @internal Reset cached env values — test-only. */
export function _resetEnvCache(): void {
	_envSiteUrl = null;
	_envAllowedOrigins = null;
}

function getEnvSiteUrl(): string | undefined {
	if (_envSiteUrl !== null) return _envSiteUrl || undefined;
	try {
		// process.env is available on Node.js; undefined on Workers
		const value =
			(typeof process !== "undefined" && process.env?.EMDASH_SITE_URL) ||
			(typeof process !== "undefined" && process.env?.SITE_URL) ||
			"";
		if (value) {
			const parsed = new URL(value);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				_envSiteUrl = "";
				return undefined;
			}
			_envSiteUrl = parsed.origin;
		} else {
			_envSiteUrl = "";
		}
	} catch {
		_envSiteUrl = "";
	}
	return _envSiteUrl || undefined;
}

/**
 * Return the public-facing origin for the site.
 *
 * Resolution order:
 *   1. `config.siteUrl` (set in astro.config.mjs, origin-normalized at startup)
 *   2. `EMDASH_SITE_URL` or `SITE_URL` env var (resolved at runtime for containers)
 *   3. `url.origin` (internal request URL — correct when no proxy)
 *
 * @param url  The request URL (`new URL(request.url)` or `Astro.url`)
 * @param config  The EmDash config (from `locals.emdash?.config`)
 * @returns Origin string, e.g. `"https://mysite.example.com"`
 */
export function getPublicOrigin(url: URL, config?: SiteUrlConfig): string {
	return config?.siteUrl || getEnvSiteUrl() || url.origin;
}

/**
 * Resolve additional accepted passkey origins from runtime environment.
 *
 * Reads `EMDASH_ALLOWED_ORIGINS` (comma-separated list of origins) for
 * multi-origin deployments where the same RP is reachable under several
 * hostnames sharing the registrable parent domain (e.g. apex + preview).
 *
 * Each entry is parsed via `new URL()` and reduced to its `origin`. Unlike
 * `getEnvSiteUrl` (which silently falls back to `url.origin` on bad input),
 * this throws on any unparseable or non-http(s) entry — `EMDASH_ALLOWED_ORIGINS`
 * is an allowlist for passkey verification, so silently dropping a typo would
 * surface as "I can't authenticate on this origin" with no diagnostic. Fail
 * loud at first read.
 *
 * Uses `process.env` (Vite leaves it untouched at runtime). Result is cached
 * on success.
 */
let _envAllowedOrigins: string[] | null = null;

export function getEnvAllowedOrigins(): string[] {
	if (_envAllowedOrigins !== null) return _envAllowedOrigins;
	const raw = typeof process !== "undefined" ? process.env?.EMDASH_ALLOWED_ORIGINS || "" : "";
	const parsed: string[] = [];
	for (const entry of raw.split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		let u: URL;
		try {
			u = new URL(trimmed);
		} catch (e) {
			throw new Error(`EmDash config error in EMDASH_ALLOWED_ORIGINS: invalid URL: "${trimmed}"`, {
				cause: e,
			});
		}
		if (u.protocol !== "http:" && u.protocol !== "https:") {
			throw new Error(
				`EmDash config error in EMDASH_ALLOWED_ORIGINS: origin must be http or https: "${trimmed}" (got ${u.protocol})`,
			);
		}
		parsed.push(u.origin);
	}
	_envAllowedOrigins = parsed;
	return parsed;
}

/**
 * Build a full public URL by appending a path to the public origin.
 *
 * @param url  The request URL
 * @param config  The EmDash config
 * @param path  Path to append (must start with `/`)
 * @returns Full URL string, e.g. `"https://mysite.example.com/_emdash/admin/login"`
 */
export function getPublicUrl(url: URL, config: SiteUrlConfig | undefined, path: string): string {
	return `${getPublicOrigin(url, config)}${path}`;
}
