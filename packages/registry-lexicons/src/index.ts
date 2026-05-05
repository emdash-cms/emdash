/**
 * @emdash-cms/registry-lexicons
 *
 * Generated TypeScript types and runtime validation schemas for the EmDash
 * plugin registry lexicons under `com.emdashcms.experimental.*`.
 *
 * EXPERIMENTAL: NSIDs and shapes will change. Once the registry stabilises the
 * NSIDs are expected to migrate to either `pm.fair.package.*` (if FAIR adopts the
 * shape) or `com.emdashcms.package.*`. Pin to an exact version while we iterate.
 *
 * The exports below are namespace re-exports so consumers can write:
 *
 *   import { PackageProfile } from "@emdash-cms/registry-lexicons";
 *   const profile: PackageProfile.Main = { ... };
 *
 * Each namespace exposes (where applicable):
 *   - `Main`, `<Def>` interfaces — the shape of records / XRPC params / outputs
 *   - `mainSchema`, `<def>Schema` — runtime validators from `@atcute/lexicons`
 *
 * The generated modules also augment `@atcute/lexicons/ambient` `Records` and
 * `XRPCQueries` so `@atcute/client` callers get strong typing automatically.
 */

export * as AggregatorDefs from "./generated/types/com/emdashcms/experimental/aggregator/defs.js";
export * as AggregatorGetLatestRelease from "./generated/types/com/emdashcms/experimental/aggregator/getLatestRelease.js";
export * as AggregatorGetPackage from "./generated/types/com/emdashcms/experimental/aggregator/getPackage.js";
export * as AggregatorListReleases from "./generated/types/com/emdashcms/experimental/aggregator/listReleases.js";
export * as AggregatorResolvePackage from "./generated/types/com/emdashcms/experimental/aggregator/resolvePackage.js";
export * as AggregatorSearchPackages from "./generated/types/com/emdashcms/experimental/aggregator/searchPackages.js";

export * as PackageProfile from "./generated/types/com/emdashcms/experimental/package/profile.js";
export * as PackageRelease from "./generated/types/com/emdashcms/experimental/package/release.js";
export * as PackageReleaseExtension from "./generated/types/com/emdashcms/experimental/package/releaseExtension.js";

export * as PublisherProfile from "./generated/types/com/emdashcms/experimental/publisher/profile.js";
export * as PublisherVerification from "./generated/types/com/emdashcms/experimental/publisher/verification.js";

/**
 * NSID constants for the lexicons defined by this package. Useful for consumers
 * that need to reference a record collection by string (e.g. when issuing
 * `listRecords` or `putRecord` calls against a PDS).
 */
export const NSID = {
	packageProfile: "com.emdashcms.experimental.package.profile",
	packageRelease: "com.emdashcms.experimental.package.release",
	packageReleaseExtension: "com.emdashcms.experimental.package.releaseExtension",
	publisherProfile: "com.emdashcms.experimental.publisher.profile",
	publisherVerification: "com.emdashcms.experimental.publisher.verification",
	aggregatorDefs: "com.emdashcms.experimental.aggregator.defs",
	aggregatorGetLatestRelease: "com.emdashcms.experimental.aggregator.getLatestRelease",
	aggregatorGetPackage: "com.emdashcms.experimental.aggregator.getPackage",
	aggregatorListReleases: "com.emdashcms.experimental.aggregator.listReleases",
	aggregatorResolvePackage: "com.emdashcms.experimental.aggregator.resolvePackage",
	aggregatorSearchPackages: "com.emdashcms.experimental.aggregator.searchPackages",
} as const;

export type NSIDValue = (typeof NSID)[keyof typeof NSID];

import type * as PackageProfileNs from "./generated/types/com/emdashcms/experimental/package/profile.js";
import type * as PackageReleaseNs from "./generated/types/com/emdashcms/experimental/package/release.js";
import type * as PackageReleaseExtensionNs from "./generated/types/com/emdashcms/experimental/package/releaseExtension.js";
import type * as PublisherProfileNs from "./generated/types/com/emdashcms/experimental/publisher/profile.js";
import type * as PublisherVerificationNs from "./generated/types/com/emdashcms/experimental/publisher/verification.js";

/**
 * Map from `record`-shaped NSIDs to the typed record body the publisher writes
 * to its PDS. Used by `PublishingClient.putRecord` (and any other typed-write
 * helper) to ensure callers pass a record matching the collection's lexicon.
 *
 * Query / procedure NSIDs (the `aggregator.*` ones) are deliberately absent --
 * they aren't records.
 */
export interface RegistryRecords {
	"com.emdashcms.experimental.package.profile": PackageProfileNs.Main;
	"com.emdashcms.experimental.package.release": PackageReleaseNs.Main;
	"com.emdashcms.experimental.package.releaseExtension": PackageReleaseExtensionNs.Main;
	"com.emdashcms.experimental.publisher.profile": PublisherProfileNs.Main;
	"com.emdashcms.experimental.publisher.verification": PublisherVerificationNs.Main;
}

export type RegistryRecordCollection = keyof RegistryRecords;
