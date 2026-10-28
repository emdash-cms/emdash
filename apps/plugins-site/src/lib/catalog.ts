import { ClientResponseError } from "@emdash-cms/registry-client";
import { DiscoveryClient, type ValidatedPackageView } from "@emdash-cms/registry-client/discovery";
import { LATEST_RELEASE_TIMEOUT_MS, type RegistryEntryData } from "@emdash-cms/registry-loader";

import { REGISTRY_CLIENT_OPTIONS } from "./registry.js";

const REGISTRY_PAGE_LIMIT = 100;
/** The registry refuses cursors past its first 10,000 results. */
const MAX_REGISTRY_PAGES = 100;

const registry = new DiscoveryClient(REGISTRY_CLIENT_OPTIONS);

export type CatalogSearchResult = { packages: ValidatedPackageView[] } | { error: Error };

/**
 * Every plugin that matches `query`, following the registry's cursor to the
 * last page, since the registry reports no total. Errors keep the registry
 * client's error as their `cause`, as live collection errors do.
 */
export async function searchCatalog(
	query: string,
	client: DiscoveryClient = registry,
): Promise<CatalogSearchResult> {
	const packages: ValidatedPackageView[] = [];
	let cursor: string | undefined;
	try {
		for (let page = 0; page < MAX_REGISTRY_PAGES; page++) {
			const result = await client.searchPackages({
				...(query ? { q: query } : {}),
				limit: REGISTRY_PAGE_LIMIT,
				...(cursor ? { cursor } : {}),
			});
			packages.push(...result.packages);
			cursor = result.cursor;
			if (!cursor) break;
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { error: new Error(`Failed to search the registry: ${message}`, { cause: error }) };
	}
	return { packages };
}

/**
 * Adds each plugin's latest release, which its card needs for the icon and the
 * permission count. A release that fails to load or takes longer than the
 * registry loader's timeout is left out, as the loader does.
 */
export function withLatestReleases(
	packages: readonly ValidatedPackageView[],
	client: DiscoveryClient = registry,
): Promise<RegistryEntryData[]> {
	return Promise.all(
		packages.map(async (pkg) => {
			const latestRelease = pkg.latestVersion
				? await withTimeout(
						client.getLatestRelease({ did: pkg.did, package: pkg.slug }),
						LATEST_RELEASE_TIMEOUT_MS,
					).catch((error: unknown) => {
						if (!(error instanceof ClientResponseError && error.error === "NotFound")) {
							console.warn(
								`[plugins-site] failed to load the latest release of ${pkg.did}/${pkg.slug}:`,
								error,
							);
						}
						return undefined;
					})
				: undefined;
			return { package: pkg, ...(latestRelease ? { latestRelease } : {}) };
		}),
	);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
		promise.then(resolve, reject).finally(() => clearTimeout(timer));
	});
}
