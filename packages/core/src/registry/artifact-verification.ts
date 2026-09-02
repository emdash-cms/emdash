import type { VerificationErrorCode } from "@emdash-cms/registry-verification";
import { validatePluginBundle } from "@emdash-cms/registry-verification/bundle";
import {
	computeArtifactDigestCandidates,
	verifyMultihash,
} from "@emdash-cms/registry-verification/checksum";

import { pluginManifestSchema, reconcileManifestAccess } from "../plugins/manifest-schema.js";
import type { PluginBundle } from "../plugins/marketplace.js";

const bundleDecoder = new TextDecoder("utf-8", { fatal: true });

export type RegistryArtifactVerificationCode =
	| VerificationErrorCode
	| "BUNDLE_INVALID_CODE_ENCODING"
	| "BUNDLE_RUNTIME_UNSUPPORTED";

export type RegistryArtifactVerificationResult =
	| {
			success: true;
			value: {
				bundle: PluginBundle;
				artifactDigest: Uint8Array;
				artifactDigests: readonly Uint8Array[];
			};
	  }
	| {
			success: false;
			error: { code: RegistryArtifactVerificationCode; message: string };
	  };

export async function validateRegistryArtifact(
	bytes: Uint8Array,
	checksum: string,
	slug: string,
	version: string,
): Promise<RegistryArtifactVerificationResult> {
	const checksumReport = await verifyMultihash(bytes, checksum);
	if (!checksumReport.success) return checksumReport;
	const [artifactDigest, ...artifactDigests] = await computeArtifactDigestCandidates(bytes);

	const bundleReport = await validatePluginBundle(bytes, {
		expectedSlug: slug,
		expectedVersion: version,
	});
	if (!bundleReport.success) return bundleReport;

	const manifest = pluginManifestSchema.safeParse(bundleReport.value.manifest);
	if (!manifest.success) {
		return {
			success: false,
			error: {
				code: "BUNDLE_RUNTIME_UNSUPPORTED",
				message: "The plugin bundle uses manifest features unsupported by this EmDash version.",
			},
		};
	}

	try {
		return {
			success: true,
			value: {
				bundle: {
					manifest: reconcileManifestAccess(manifest.data),
					backendCode: bundleDecoder.decode(bundleReport.value.backend),
					adminCode:
						bundleReport.value.admin === undefined
							? undefined
							: bundleDecoder.decode(bundleReport.value.admin),
					checksum,
				},
				artifactDigest,
				artifactDigests,
			},
		};
	} catch {
		return {
			success: false,
			error: {
				code: "BUNDLE_INVALID_CODE_ENCODING",
				message: "Plugin bundle code must be valid UTF-8.",
			},
		};
	}
}
