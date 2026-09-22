import { inspectPackageReleaseRecords } from "@emdash-cms/registry-verification/records";

import {
	setDefaultAuthoritativeRecordReaderForTesting,
	type AuthoritativeRecordReader,
} from "./authoritative-records.js";

export interface RegistryAuthoritativeFixture {
	publisherDid: string;
	packageSlug: string;
	version: string;
	profileCid: string;
	releaseCid: string;
	profile: unknown;
	release: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function installRegistryAuthoritativeFixture(input: unknown): void {
	if (
		!isRecord(input) ||
		typeof input.publisherDid !== "string" ||
		typeof input.packageSlug !== "string" ||
		typeof input.version !== "string" ||
		typeof input.profileCid !== "string" ||
		typeof input.releaseCid !== "string" ||
		!("profile" in input) ||
		!("release" in input)
	) {
		throw new TypeError("Registry authoritative fixture is invalid");
	}
	const fixture: RegistryAuthoritativeFixture = {
		publisherDid: input.publisherDid,
		packageSlug: input.packageSlug,
		version: input.version,
		profileCid: input.profileCid,
		releaseCid: input.releaseCid,
		profile: input.profile,
		release: input.release,
	};
	const reader: AuthoritativeRecordReader = async (publisherDid, packageSlug, version) => {
		if (
			publisherDid !== fixture.publisherDid ||
			packageSlug !== fixture.packageSlug ||
			version !== fixture.version
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
			release: fixture.release,
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
					cid: fixture.releaseCid,
					rkey,
					value: inspection.value.release,
				},
				inspection,
			},
		};
	};
	setDefaultAuthoritativeRecordReaderForTesting(reader);
}
