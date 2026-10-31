import { ClientResponseError } from "@emdash-cms/registry-client";
import { DiscoveryClient, type ValidatedPackageView } from "@emdash-cms/registry-client/discovery";
import { LATEST_RELEASE_TIMEOUT_MS, type RegistryEntryData } from "@emdash-cms/registry-loader";

import { REGISTRY_CLIENT_OPTIONS } from "./registry.js";

const REGISTRY_PAGE_LIMIT = 100;
/** Stops the walk after 10,000 results; the registry refuses offsets past 10,000. */
const MAX_REGISTRY_PAGES = 100;

const registry = new DiscoveryClient(REGISTRY_CLIENT_OPTIONS);

export type CatalogSearchResult = { packages: ValidatedPackageView[] } | { error: Error };

/**
 * Every plugin that matches `query`, following the registry's cursor to the
 * last page, since the registry reports no total. More pages than the walk
 * allows is an error, not a partial list. When the first request fails, the
 * error keeps the registry client's error as its `cause`, as live collection
 * errors do.
 */
export async function searchCatalog(
	query: string,
	client: DiscoveryClient = registry,
): Promise<CatalogSearchResult> {
	const packages = new Map<string, ValidatedPackageView>();
	let cursor: string | undefined;
	try {
		for (let page = 0; page < MAX_REGISTRY_PAGES; page++) {
			const result = await client.searchPackages({
				...(query ? { q: query } : {}),
				limit: REGISTRY_PAGE_LIMIT,
				...(cursor ? { cursor } : {}),
			});
			// A plugin published mid-walk shifts the registry's offset pages, so the
			// next page can repeat the last plugin of this one.
			for (const pkg of result.packages) packages.set(pkg.uri, pkg);
			cursor = result.cursor;
			if (!cursor) return { packages: [...packages.values()] };
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// Only the first request can be rejected for the query. A later one fails on
		// a cursor the registry issued, so it mustn't read as a rejected search.
		return {
			error: new Error(`Failed to search the registry: ${message}`, {
				cause: cursor ? undefined : error,
			}),
		};
	}
	return {
		error: new Error(`Stopped after ${MAX_REGISTRY_PAGES} registry pages with more results left`),
	};
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
