import { isDid, isHandle } from "@atcute/lexicons/syntax";
import { ClientResponseError } from "@emdash-cms/registry-client";
import {
	DiscoveryClient,
	type DiscoveryClientOptions,
	type ValidatedPackageView,
	type ValidatedReleaseView,
} from "@emdash-cms/registry-client/discovery";
import type { LiveLoader } from "astro/loaders";

export const DEFAULT_REGISTRY_URL = "https://registry.emdashcms.com";

export interface RegistryLoaderOptions extends Omit<DiscoveryClientOptions, "aggregatorUrl"> {
	/** Registry aggregator origin. Defaults to the hosted EmDash registry. */
	aggregatorUrl?: string;
}

export interface RegistryCollectionFilter {
	/** Free-text query over names, descriptions, keywords, and authors. */
	q?: string;
	/** Return packages whose latest release declares this access category. */
	capability?: string;
	/** Number of packages to return. The registry accepts 1 through 100. */
	limit?: number;
	/**
	 * Also load each package's latest release, for listings that show release
	 * artifacts such as icons. Costs one registry request per package that has a published release.
	 */
	includeLatestRelease?: boolean;
}

export interface RegistryEntryFilter {
	/** Publisher handle or DID. Handles may be prefixed with `@`. */
	publisher: string;
	/** Package slug. */
	slug: string;
}

export interface RegistryEntryData {
	package: ValidatedPackageView;
	/**
	 * Present when the package has a visible release, for single-entry loads
	 * and for collection loads with `includeLatestRelease`.
	 */
	latestRelease?: ValidatedReleaseView;
}

export function registryLoader(
	options: RegistryLoaderOptions = {},
): LiveLoader<RegistryEntryData, RegistryEntryFilter, RegistryCollectionFilter> {
	const client = new DiscoveryClient({
		...options,
		aggregatorUrl: options.aggregatorUrl ?? DEFAULT_REGISTRY_URL,
	});

	return {
		name: "@emdash-cms/registry-loader",

		async loadCollection({ filter }) {
			try {
				const { includeLatestRelease, ...query } = filter ?? {};
				const result = await client.searchPackages(query);
				const entries = await Promise.all(
					result.packages.map(async (pkg) => {
						const latestRelease =
							includeLatestRelease && pkg.latestVersion
								? await withTimeout(
										client.getLatestRelease({ did: pkg.did, package: pkg.slug }),
										LATEST_RELEASE_TIMEOUT_MS,
									).catch((error: unknown) => {
										if (!(error instanceof ClientResponseError && error.error === "NotFound")) {
											console.warn(
												`[registry-loader] failed to load the latest release of ${packageId(pkg)}:`,
												error,
											);
										}
										return undefined;
									})
								: undefined;
						return {
							id: packageId(pkg),
							data: { package: pkg, ...(latestRelease ? { latestRelease } : {}) },
							cacheHint: packageCacheHint(pkg, latestRelease),
						};
					}),
				);
				return { entries };
			} catch (error) {
				return { error: loaderError("collection", error) };
			}
		},

		async loadEntry({ filter }) {
			try {
				const publisher = filter.publisher.startsWith("@")
					? filter.publisher.slice(1)
					: filter.publisher;
				if (!publisher || !filter.slug) return undefined;

				const status = isDid(publisher)
					? await client.getPackageStatus({ did: publisher, slug: filter.slug })
					: isHandle(publisher)
						? await client.resolvePackageStatus({ handle: publisher, slug: filter.slug })
						: undefined;
				if (!status) return undefined;
				if (status.status === "unavailable") return undefined;

				const pkg = status.value;
				const latestRelease = pkg.latestVersion
					? await client.getLatestRelease({ did: pkg.did, package: pkg.slug })
					: undefined;
				return {
					id: packageId(pkg),
					data: {
						package: pkg,
						...(latestRelease ? { latestRelease } : {}),
					},
					cacheHint: packageCacheHint(pkg, latestRelease),
				};
			} catch (error) {
				if (
					error instanceof ClientResponseError &&
					(error.error === "NotFound" || error.error === "HandleNotFound")
				) {
					return undefined;
				}
				return { error: loaderError("entry", error) };
			}
		},
	};
}

/** How long a collection load waits for each package's latest release. */
export const LATEST_RELEASE_TIMEOUT_MS = 3000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
		promise.then(resolve, reject).finally(() => clearTimeout(timer));
	});
}

function packageId(pkg: ValidatedPackageView): string {
	return `${pkg.did}/${pkg.slug}`;
}

function packageCacheHint(
	pkg: ValidatedPackageView,
	release?: ValidatedReleaseView,
): {
	tags: string[];
	lastModified?: Date;
} {
	const timestamps = [pkg.profile?.lastUpdated, pkg.indexedAt, release?.indexedAt]
		.filter((value): value is string => typeof value === "string")
		.map((value) => new Date(value))
		.filter((value) => !Number.isNaN(value.valueOf()));
	const lastModified = timestamps.toSorted((a, b) => b.valueOf() - a.valueOf())[0];
	return {
		tags: [pkg.uri, ...(release ? [release.uri] : [])],
		...(lastModified ? { lastModified } : {}),
	};
}

function loaderError(scope: "collection" | "entry", error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(`Failed to load registry ${scope}: ${message}`, { cause: error });
}
