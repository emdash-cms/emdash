// eslint-disable-next-line @typescript-eslint/no-empty-named-blocks, eslint-plugin-import/no-empty-named-blocks, eslint-plugin-unicorn/require-module-specifiers, import/no-empty-named-blocks, unicorn/require-module-specifiers
import type {} from "@atcute/atproto";
import { Client, ok, simpleFetchHandler } from "@atcute/client";
import { parseCanonicalResourceUri } from "@atcute/lexicons";
import { safeParse } from "@atcute/lexicons/validations";
import { NSID, PackageProfile, PackageRelease } from "@emdash-cms/registry-lexicons";
import compare from "semver/functions/compare.js";
import valid from "semver/functions/valid.js";

import type { Did } from "../credentials/types.js";

export const DEFAULT_DIRECT_PDS_MAX_RECORDS = 1_000;
export const DEFAULT_DIRECT_PDS_PAGE_SIZE = 100;

export type DirectPdsReadErrorCode =
	| "ENUMERATION_CURSOR_REPEATED"
	| "ENUMERATION_TRUNCATED"
	| "PROFILE_IDENTITY_MISMATCH"
	| "PROFILE_LEXICON_INVALID"
	| "RECORD_CID_MISSING"
	| "RELEASE_ENUMERATION_AMBIGUOUS"
	| "RELEASE_IDENTITY_MISMATCH"
	| "RELEASE_LEXICON_INVALID"
	| "RELEASE_VERSION_INVALID";

export class DirectPdsReadError extends Error {
	readonly code: DirectPdsReadErrorCode;

	constructor(code: DirectPdsReadErrorCode, message: string) {
		super(message);
		this.name = "DirectPdsReadError";
		this.code = code;
	}
}

export interface DirectPdsClientOptions {
	did: Did;
	pds: string;
	fetch?: typeof fetch;
}

export interface DirectPdsProfileRecord {
	uri: string;
	cid: string;
	rkey: string;
	value: PackageProfile.Main;
}

export interface DirectPdsReleaseRecord {
	uri: string;
	cid: string;
	rkey: string;
	value: PackageRelease.Main;
}

export interface DirectPdsEnumerationOptions {
	maxRecords?: number;
	pageSize?: number;
}

/** Unauthenticated reads against one explicitly configured publisher PDS. */
export class DirectPdsClient {
	readonly did: Did;
	readonly pds: string;
	readonly #client: Client;

	constructor(options: DirectPdsClientOptions) {
		validatePdsOrigin(options.pds);
		this.did = options.did;
		this.pds = options.pds;
		this.#client = new Client({
			handler: simpleFetchHandler({
				service: options.pds,
				fetch: options.fetch ?? globalThis.fetch,
			}),
		});
	}

	async getPackageProfile(packageSlug: string): Promise<DirectPdsProfileRecord> {
		validatePackageSlug(packageSlug);
		const data = await ok(
			this.#client.get("com.atproto.repo.getRecord", {
				params: { repo: this.did, collection: NSID.packageProfile, rkey: packageSlug },
			}),
		);
		const identity = parseIdentity(data.uri, this.did, NSID.packageProfile);
		if (!identity || identity.rkey !== packageSlug) {
			throw new DirectPdsReadError(
				"PROFILE_IDENTITY_MISMATCH",
				"The PDS returned a profile with a different record identity.",
			);
		}
		const parsed = safeParse(PackageProfile.mainSchema, data.value);
		if (!parsed.ok) {
			throw new DirectPdsReadError(
				"PROFILE_LEXICON_INVALID",
				"The PDS returned a malformed package profile.",
			);
		}
		if (parsed.value.id !== data.uri || (parsed.value.slug && parsed.value.slug !== packageSlug)) {
			throw new DirectPdsReadError(
				"PROFILE_IDENTITY_MISMATCH",
				"The signed profile does not match its authoritative record identity.",
			);
		}
		if (!data.cid) throw missingCid();
		return { uri: data.uri, cid: data.cid, rkey: identity.rkey, value: parsed.value };
	}

	async getPackageRelease(packageSlug: string, version: string): Promise<DirectPdsReleaseRecord> {
		validatePackageSlug(packageSlug);
		const rkey = `${packageSlug}:${version}`;
		const data = await ok(
			this.#client.get("com.atproto.repo.getRecord", {
				params: { repo: this.did, collection: NSID.packageRelease, rkey },
			}),
		);
		return validateReleaseRecord(data, this.did, packageSlug, rkey);
	}

	async listPackageReleases(
		packageSlug: string,
		options: DirectPdsEnumerationOptions = {},
	): Promise<DirectPdsReleaseRecord[]> {
		validatePackageSlug(packageSlug);
		const maxRecords = options.maxRecords ?? DEFAULT_DIRECT_PDS_MAX_RECORDS;
		const pageSize = options.pageSize ?? DEFAULT_DIRECT_PDS_PAGE_SIZE;
		if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
			throw new RangeError("maxRecords must be a positive safe integer");
		}
		if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
			throw new RangeError("pageSize must be an integer from 1 to 100");
		}

		const releases: DirectPdsReleaseRecord[] = [];
		const seenCursors = new Set<string>();
		const seenRkeys = new Set<string>();
		let enumerated = 0;
		let cursor: string | undefined;
		const maxPages = Math.ceil(maxRecords / pageSize) + 1;

		for (let page = 0; page < maxPages; page += 1) {
			const data = await ok(
				this.#client.get("com.atproto.repo.listRecords", {
					params: {
						repo: this.did,
						collection: NSID.packageRelease,
						limit: Math.min(pageSize, maxRecords - enumerated),
						...(cursor ? { cursor } : {}),
					},
				}),
			);
			enumerated += data.records.length;
			if (enumerated > maxRecords) {
				throw new DirectPdsReadError(
					"ENUMERATION_TRUNCATED",
					"The PDS returned more records than the configured bound.",
				);
			}

			for (const record of data.records) {
				const identity = parseIdentity(record.uri, this.did, NSID.packageRelease);
				if (!identity) {
					throw new DirectPdsReadError(
						"RELEASE_ENUMERATION_AMBIGUOUS",
						"The PDS returned a release with a non-authoritative identity.",
					);
				}
				if (!identity.rkey.startsWith(`${packageSlug}:`)) continue;
				if (seenRkeys.has(identity.rkey)) {
					throw new DirectPdsReadError(
						"RELEASE_ENUMERATION_AMBIGUOUS",
						"The PDS returned a duplicate release record key.",
					);
				}
				seenRkeys.add(identity.rkey);
				releases.push(validateReleaseRecord(record, this.did, packageSlug, identity.rkey));
			}

			if (!data.cursor) return releases;
			if (enumerated >= maxRecords || page === maxPages - 1) {
				throw new DirectPdsReadError(
					"ENUMERATION_TRUNCATED",
					"Release enumeration exceeded its configured bound.",
				);
			}
			if (seenCursors.has(data.cursor)) {
				throw new DirectPdsReadError(
					"ENUMERATION_CURSOR_REPEATED",
					"The PDS repeated an enumeration cursor.",
				);
			}
			seenCursors.add(data.cursor);
			cursor = data.cursor;
		}

		throw new DirectPdsReadError(
			"ENUMERATION_TRUNCATED",
			"Release enumeration exceeded its page bound.",
		);
	}
}

/** Select the highest-semver current release, excluding the proposed record key. */
export function selectSemverBaseline(
	releases: readonly DirectPdsReleaseRecord[],
	options: { excludeRkey: string },
): DirectPdsReleaseRecord | null {
	const separator = options.excludeRkey.indexOf(":");
	const packageSlug = options.excludeRkey.slice(0, separator);
	if (separator < 1 || !PACKAGE_SLUG_RE.test(packageSlug)) {
		throw new DirectPdsReadError(
			"RELEASE_IDENTITY_MISMATCH",
			"The proposed release key has no canonical package identity.",
		);
	}
	let baseline: DirectPdsReleaseRecord | null = null;
	const versions = new Set<string>();
	for (const release of releases) {
		if (release.rkey === options.excludeRkey) continue;
		const version = release.value.version;
		if (release.value.package !== packageSlug || release.rkey !== `${packageSlug}:${version}`) {
			throw new DirectPdsReadError(
				"RELEASE_IDENTITY_MISMATCH",
				"A baseline release belongs to a different package identity.",
			);
		}
		if (!isCanonicalVersion(version)) {
			throw new DirectPdsReadError(
				"RELEASE_VERSION_INVALID",
				"A release cannot participate in semver baseline selection.",
			);
		}
		if (versions.has(version)) {
			throw new DirectPdsReadError(
				"RELEASE_ENUMERATION_AMBIGUOUS",
				"Multiple releases have the same semantic version.",
			);
		}
		versions.add(version);
		if (!baseline || compare(version, baseline.value.version) > 0) baseline = release;
	}
	return baseline;
}

function validateReleaseRecord(
	record: { uri: string; cid?: string; value: unknown },
	did: string,
	packageSlug: string,
	expectedRkey: string,
): DirectPdsReleaseRecord {
	const identity = parseIdentity(record.uri, did, NSID.packageRelease);
	if (!identity || identity.rkey !== expectedRkey) {
		throw new DirectPdsReadError(
			"RELEASE_IDENTITY_MISMATCH",
			"The PDS returned a release with a different record identity.",
		);
	}
	const parsed = safeParse(PackageRelease.mainSchema, record.value);
	if (!parsed.ok) {
		throw new DirectPdsReadError(
			"RELEASE_LEXICON_INVALID",
			"The PDS returned a malformed package release.",
		);
	}
	if (
		parsed.value.package !== packageSlug ||
		!isCanonicalVersion(parsed.value.version) ||
		expectedRkey !== `${packageSlug}:${parsed.value.version}`
	) {
		throw new DirectPdsReadError(
			"RELEASE_IDENTITY_MISMATCH",
			"The signed release does not match its package, version, and record key.",
		);
	}
	if (!record.cid) throw missingCid();
	return { uri: record.uri, cid: record.cid, rkey: identity.rkey, value: parsed.value };
}

function parseIdentity(uri: string, did: string, collection: string): { rkey: string } | null {
	try {
		const parsed = parseCanonicalResourceUri(uri);
		return parsed.repo === did && parsed.collection === collection && parsed.rkey
			? { rkey: parsed.rkey }
			: null;
	} catch {
		return null;
	}
}

function isCanonicalVersion(version: string): boolean {
	return !version.includes("+") && valid(version) === version;
}

const PACKAGE_SLUG_RE = /^[a-z][a-z0-9_-]{0,63}$/;

function validatePackageSlug(value: string): void {
	if (!PACKAGE_SLUG_RE.test(value)) {
		throw new DirectPdsReadError(
			"RELEASE_IDENTITY_MISMATCH",
			"The package slug is not valid for an authoritative release identity.",
		);
	}
}

function validatePdsOrigin(value: string): void {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	) {
		throw new TypeError("pds must be an HTTPS origin");
	}
}

function missingCid(): DirectPdsReadError {
	return new DirectPdsReadError(
		"RECORD_CID_MISSING",
		"The PDS response omitted the authoritative record CID.",
	);
}
