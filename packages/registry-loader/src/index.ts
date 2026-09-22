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
}

export interface RegistryEntryFilter {
	/** Publisher handle or DID. Handles may be prefixed with `@`. */
	publisher: string;
	/** Package slug. */
	slug: string;
}

export interface RegistryEntryData {
	package: ValidatedPackageView;
	/** Present for single-entry loads when the package has a visible release. */
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
				const result = await client.searchPackages(filter ?? {});
				return {
					entries: result.packages.map((pkg) => ({
						id: packageId(pkg),
						data: { package: pkg },
						cacheHint: packageCacheHint(pkg),
					})),
				};
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
