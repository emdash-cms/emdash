/**
 * Import source registry
 *
 * Manages available import sources and provides URL probing.
 */

import { wordpressPluginSource } from "./sources/wordpress-plugin.js";
import { wordpressRestSource } from "./sources/wordpress-rest.js";
import { wxrSource } from "./sources/wxr.js";
import { resolveAndValidateExternalUrl } from "./ssrf.js";
import type { ImportSource, ProbeResult, SourceProbeResult } from "./types.js";

// Regex pattern for URL normalization
const TRAILING_SLASHES_PATTERN = /\/+$/;

/** Registered import sources */
const sources = new Map<string, ImportSource>();

/** Whether the built-in sources have been added (or cleared on purpose). */
let builtinsAdded = false;

/**
 * Add the built-in sources on first use rather than when the module is
 * imported, so the registry has no import-time side effect for a bundler to
 * drop. Priority order, most specific first: the plugin source, if the site
 * has our plugin, then the REST API, then a WXR file.
 */
function ensureBuiltinSources(): void {
	if (builtinsAdded) return;
	builtinsAdded = true;
	for (const source of [wordpressPluginSource, wordpressRestSource, wxrSource]) {
		sources.set(source.id, source);
	}
}

/**
 * A bot-protection challenge page (for example Cloudflare's "Just a moment...")
 * answered instead of the source's API. Server-side requests can't solve it,
 * so the site owner has to let the importer's requests through.
 */
export class SiteChallengeError extends Error {
	constructor() {
		super(
			"Cloudflare's bot protection answered with a challenge page instead of the EmDash Exporter API. Let requests to /wp-json/emdash/v1/ and ?rest_route=/emdash/v1/ through (for example with a WAF custom rule that skips bot protection), or pause bot protection during the migration.",
		);
		this.name = "SiteChallengeError";
	}
}

/**
 * Register an import source
 */
export function registerSource(source: ImportSource): void {
	// Built-ins first, so a source registered later still comes after them.
	ensureBuiltinSources();
	sources.set(source.id, source);
}

/**
 * Get a source by ID
 */
export function getSource(id: string): ImportSource | undefined {
	ensureBuiltinSources();
	return sources.get(id);
}

/**
 * Get all registered sources
 */
export function getAllSources(): ImportSource[] {
	ensureBuiltinSources();
	return [...sources.values()];
}

/**
 * Get sources that can handle file uploads
 */
export function getFileSources(): ImportSource[] {
	ensureBuiltinSources();
	return getAllSources().filter((s) => s.requiresFile);
}

/**
 * Get sources that can probe URLs
 */
export function getUrlSources(): ImportSource[] {
	ensureBuiltinSources();
	return getAllSources().filter((s) => s.canProbe);
}

/**
 * Probe a URL against all registered sources
 *
 * Returns probe results sorted by confidence (definite > likely > possible)
 */
export async function probeUrl(url: string): Promise<ProbeResult> {
	// Normalize URL
	let normalizedUrl = url.trim();
	if (!normalizedUrl.startsWith("http")) {
		normalizedUrl = `https://${normalizedUrl}`;
	}

	// Remove trailing slash for consistency
	normalizedUrl = normalizedUrl.replace(TRAILING_SLASHES_PATTERN, "");

	// SSRF: reject internal/private network targets. DNS resolution
	// catches hostnames that resolve to private addresses.
	await resolveAndValidateExternalUrl(normalizedUrl);

	ensureBuiltinSources();
	const results: SourceProbeResult[] = [];
	const urlSources = getUrlSources();
	let challenged = false;

	// Probe all sources in parallel
	const probePromises = urlSources.map(async (source) => {
		try {
			const result = await source.probe?.(normalizedUrl);
			if (result) {
				return result;
			}
		} catch (error) {
			if (error instanceof SiteChallengeError) challenged = true;
			// Probe failed, skip this source
			console.debug(`Probe failed for ${source.id}:`, error);
		}
		return null;
	});

	const probeResults = await Promise.allSettled(probePromises);

	for (const result of probeResults) {
		if (result.status === "fulfilled" && result.value) {
			results.push(result.value);
		}
	}

	// Sort by confidence
	const confidenceOrder = { definite: 0, likely: 1, possible: 2 };
	results.sort((a, b) => confidenceOrder[a.confidence] - confidenceOrder[b.confidence]);

	return {
		url: normalizedUrl,
		isWordPress: results.length > 0,
		bestMatch: results[0] ?? null,
		allMatches: results,
		...(challenged && results.length === 0 ? { challenged: true } : {}),
	};
}

/**
 * Clear all registered sources (useful for testing). The built-in sources
 * stay cleared: they are not added back on the next lookup.
 */
export function clearSources(): void {
	builtinsAdded = true;
	sources.clear();
}
