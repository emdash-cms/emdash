/**
 * Resolution and validation of multi-origin passkey verification.
 *
 * `allowedOrigins` lets one EmDash deployment accept passkey assertions from
 * several hostnames sharing the same `rpId` (e.g. apex + preview/staging
 * subdomains under one registrable parent). Origins come from two sources:
 *
 *   - `EmDashConfig.allowedOrigins` (declared in `astro.config.mjs`)
 *   - `EMDASH_ALLOWED_ORIGINS` (comma-separated runtime env var)
 *
 * Sources are merged (union of permissions, deduplicated). Each entry is
 * validated against `siteUrl` to fail loud on dead config the browser would
 * never honor.
 */

import { getEnvAllowedOrigins } from "../api/public-url.js";
import type { EmDashConfig } from "../astro/integration/runtime.js";

export type AllowedOriginSource = "config.allowedOrigins" | "EMDASH_ALLOWED_ORIGINS";

export interface TaggedOrigin {
	/** Raw entry as declared by the operator. */
	origin: string;
	/** Where the entry came from (used for source-attributed errors). */
	source: AllowedOriginSource;
}

/**
 * Collect raw allowedOrigins from config and env, source-tagged.
 *
 * Returns raw values — the caller is expected to pass the result through
 * `validateAllowedOrigins()` before use in passkey verification.
 */
export function getConfiguredAllowedOrigins(config?: EmDashConfig): TaggedOrigin[] {
	const tagged: TaggedOrigin[] = [];
	if (config?.allowedOrigins) {
		for (const origin of config.allowedOrigins) {
			if (origin) tagged.push({ origin, source: "config.allowedOrigins" });
		}
	}
	for (const origin of getEnvAllowedOrigins()) {
		tagged.push({ origin, source: "EMDASH_ALLOWED_ORIGINS" });
	}
	return tagged;
}

/**
 * Validate per-entry shape rules (no `siteUrl` needed):
 *   - parses as `URL`
 *   - protocol is `http:` or `https:`
 *   - hostname has no trailing dot (`example.com.` rejected)
 *   - hostname has no empty labels (`foo..example.com` rejected)
 *
 * Returns the deduplicated, normalized origin form (`URL.origin`) of every
 * input, in input order. Throws on the first violation with a source-tagged
 * error message.
 */
export function validateOriginShape(tagged: TaggedOrigin[]): string[] {
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const { origin, source } of tagged) {
		let parsed: URL;
		try {
			parsed = new URL(origin);
		} catch (e) {
			throw configError(source, `invalid URL: "${origin}"`, e);
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw configError(
				source,
				`origin must be http or https: "${origin}" (got ${parsed.protocol})`,
			);
		}
		if (parsed.hostname.endsWith(".")) {
			throw configError(
				source,
				`hostname has a trailing dot: "${origin}". Remove the trailing dot — assertion origins from the browser do not include it.`,
			);
		}
		if (parsed.hostname.split(".").includes("")) {
			throw configError(source, `hostname has empty labels: "${origin}"`);
		}
		if (!seen.has(parsed.origin)) {
			seen.add(parsed.origin);
			normalized.push(parsed.origin);
		}
	}
	return normalized;
}

/**
 * Validate the effective merged allowedOrigins set against `siteUrl`.
 *
 * Performs `validateOriginShape()` plus the siteUrl-dependent rules:
 *   - Rule A: non-empty origins ⇒ `siteUrl` is set
 *   - `siteUrl` hostname is not an IP literal (multi-origin requires a domain)
 *   - `siteUrl` hostname has no trailing dot (cannot match assertion origins)
 *   - Rule B: each origin's hostname is `siteHost` exactly or a subdomain
 *
 * Throws on first violation. Returns the deduplicated normalized origins.
 *
 * Use this at the runtime chokepoint (where config + env are merged into the
 * effective set). At Astro integration init, prefer `validateOriginShape()`
 * for shape-only checks on `config.allowedOrigins`, since `siteUrl` may be
 * supplied at runtime via `EMDASH_SITE_URL`.
 */
export function validateAllowedOrigins(
	siteUrl: string | undefined,
	tagged: TaggedOrigin[],
): string[] {
	const normalized = validateOriginShape(tagged);
	if (normalized.length === 0) return normalized;

	if (!siteUrl) {
		throw new Error(
			`EmDash config error: allowedOrigins is set (${normalized.length} ${
				normalized.length === 1 ? "entry" : "entries"
			}) but siteUrl is not. Without a canonical siteUrl, rpId is derived from the request hostname, defeating multi-origin passkeys. Set siteUrl in astro.config.mjs or via EMDASH_SITE_URL.`,
		);
	}

	let siteHost: string;
	try {
		siteHost = new URL(siteUrl).hostname;
	} catch (e) {
		throw new Error(`EmDash config error: siteUrl is not a valid URL: "${siteUrl}"`, {
			cause: e,
		});
	}

	if (siteHost.endsWith(".")) {
		throw new Error(
			`EmDash config error: siteUrl "${siteUrl}" has a trailing-dot hostname, which cannot match assertion origins. Remove the trailing dot when using allowedOrigins.`,
		);
	}
	if (isIPLiteralHostname(siteHost)) {
		throw new Error(
			`EmDash config error: siteUrl "${siteUrl}" uses an IP-literal hostname. Multi-origin passkeys require a domain-based siteUrl — IP addresses cannot have valid subdomains for WebAuthn rpId.`,
		);
	}

	for (const { origin, source } of tagged) {
		const h = new URL(origin).hostname;
		if (h !== siteHost && !h.endsWith("." + siteHost)) {
			throw configError(
				source,
				`"${origin}" is not a subdomain of siteUrl "${siteUrl}". Allowed origins must be the same hostname as siteUrl or a subdomain of it.`,
			);
		}
	}

	return normalized;
}

function configError(source: AllowedOriginSource, detail: string, cause?: unknown): Error {
	const err = new Error(`EmDash config error in ${source}: ${detail}`);
	if (cause !== undefined) (err as Error & { cause?: unknown }).cause = cause;
	return err;
}

const IPV4_DOTTED_DECIMAL_RE = /^\d+(\.\d+){3}$/;

function isIPLiteralHostname(h: string): boolean {
	// IPv6 hostnames are bracketed by URL.hostname, e.g. "[::1]"
	if (h.startsWith("[")) return true;
	// IPv4 dotted-decimal
	return IPV4_DOTTED_DECIMAL_RE.test(h);
}
