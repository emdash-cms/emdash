/**
 * Import source registry
 *
 * Manages available import sources and provides URL probing.
 */

import { resolveAndValidateExternalUrl } from "./ssrf.js";
import type { ImportSource, ProbeResult, SourceProbeResult } from "./types.js";

// Regex pattern for URL normalization
const TRAILING_SLASHES_PATTERN = /\/+$/;

/** Registered import sources */
const sources = new Map<string, ImportSource>();

/**
 * Register an import source
 */
export function registerSource(source: ImportSource): void {
	sources.set(source.id, source);
}

/**
 * Get a source by ID
 */
export function getSource(id: string): ImportSource | undefined {
	return sources.get(id);
}

/**
 * Get all registered sources
 */
export function getAllSources(): ImportSource[] {
	return [...sources.values()];
}

/**
 * Get sources that can handle file uploads
 */
export function getFileSources(): ImportSource[] {
	return getAllSources().filter((s) => s.requiresFile);
}

/**
 * Get sources that can probe URLs
 */
export function getUrlSources(): ImportSource[] {
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

	const results: SourceProbeResult[] = [];
	const urlSources = getUrlSources();

	// Probe all sources in parallel
	const probePromises = urlSources.map(async (source) => {
		try {
			const result = await source.probe?.(normalizedUrl);
			if (result) {
				return result;
			}
		} catch (error) {
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
	};
}

/**
 * Clear all registered sources (useful for testing)
 */
export function clearSources(): void {
	sources.clear();
}
