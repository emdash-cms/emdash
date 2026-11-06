import { inspectPackageReleaseRecords } from "@emdash-cms/registry-verification/records";

import {
	setDefaultAuthoritativeRecordReaderForTesting,
	type AuthoritativeRecordReader,
} from "./authoritative-records.js";

interface RegistryAuthoritativeFixtureBase {
	publisherDid: string;
	packageSlug: string;
	profileCid: string;
	profile: unknown;
}

export type RegistryAuthoritativeFixture = RegistryAuthoritativeFixtureBase &
	(
		| { version: string; releaseCid: string; release: unknown; releases?: never }
		| {
				releases: Array<{ version: string; releaseCid: string; release: unknown }>;
				version?: never;
				releaseCid?: never;
				release?: never;
		  }
	);

interface NormalizedRegistryAuthoritativeFixture extends RegistryAuthoritativeFixtureBase {
	releases: Array<{ version: string; releaseCid: string; release: unknown }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function installRegistryAuthoritativeFixture(input: unknown): void {
	if (
		!isRecord(input) ||
		typeof input.publisherDid !== "string" ||
		typeof input.packageSlug !== "string" ||
		typeof input.profileCid !== "string" ||
		!("profile" in input) ||
		(!("releases" in input) &&
			!(
				typeof input.version === "string" &&
				typeof input.releaseCid === "string" &&
				"release" in input
			))
	) {
		throw new TypeError("Registry authoritative fixture is invalid");
	}
	let releases: Array<{ version: string; releaseCid: string; release: unknown }>;
	if (Array.isArray(input.releases)) {
		releases = input.releases.filter(
			(value): value is { version: string; releaseCid: string; release: unknown } =>
				isRecord(value) &&
				typeof value.version === "string" &&
				typeof value.releaseCid === "string" &&
				"release" in value,
		);
	} else {
		if (
			typeof input.version !== "string" ||
			typeof input.releaseCid !== "string" ||
			!("release" in input)
		) {
			throw new TypeError("Registry authoritative fixture release is invalid");
		}
		releases = [
			{
				version: input.version,
				releaseCid: input.releaseCid,
				release: input.release,
			},
		];
	}
	if (
		releases.length === 0 ||
		(Array.isArray(input.releases) && releases.length !== input.releases.length)
	) {
		throw new TypeError("Registry authoritative fixture releases are invalid");
	}
	const fixture: NormalizedRegistryAuthoritativeFixture = {
		publisherDid: input.publisherDid,
		packageSlug: input.packageSlug,
		profileCid: input.profileCid,
		profile: input.profile,
		releases,
	};
	const reader: AuthoritativeRecordReader = async (publisherDid, packageSlug, version) => {
		const fixtureRelease = fixture.releases.find((release) => release.version === version);
		if (
			publisherDid !== fixture.publisherDid ||
			packageSlug !== fixture.packageSlug ||
			!fixtureRelease
		) {
			return {
				success: false,
				error: {
					code: "RECORD_NOT_FOUND",
					message: "The registry test fixture does not contain this package release.",
				},
			};
		}
		const rkey = `${packageSlug}:${version}`;
		const inspection = await inspectPackageReleaseRecords({
			publisherDid,
			package: packageSlug,
			version,
			rkey,
			profileCid: fixture.profileCid,
			profile: fixture.profile,
			release: fixtureRelease.release,
		});
		if (!inspection.success) {
			return {
				success: false,
				error: {
					code: inspection.code,
					message: inspection.reasons[0]?.message ?? "The registry test fixture is invalid.",
				},
			};
		}
		return {
			success: true,
			value: {
				publisherDid,
				packageSlug,
				version,
				profile: {
					uri: `at://${publisherDid}/com.emdashcms.experimental.package.profile/${packageSlug}`,
					cid: fixture.profileCid,
					rkey: packageSlug,
					value: inspection.value.profile,
				},
				release: {
					uri: `at://${publisherDid}/com.emdashcms.experimental.package.release/${rkey}`,
					cid: fixtureRelease.releaseCid,
					rkey,
					value: inspection.value.release,
				},
				inspection,
			},
		};
	};
	setDefaultAuthoritativeRecordReaderForTesting(reader);
}
