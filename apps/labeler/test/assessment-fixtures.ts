import type { RegistryRecords } from "@emdash-cms/registry-lexicons";

export const PUBLISHER_DID = "did:plc:assessmentfixture00000000";
export const PROFILE_URI = `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.profile/gallery`;
export const RELEASE_URI = `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.release/gallery:1.2.3`;
export const PROFILE_CID = "bafyreiabaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibae";
export const RELEASE_CID = "bafyreiacaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcai";

export const PROFILE_RECORD = {
	$type: "com.emdashcms.experimental.package.profile",
	id: PROFILE_URI,
	type: "emdash-plugin",
	slug: "gallery",
	name: "Gallery",
	description: "A media gallery for EmDash.",
	keywords: ["gallery", "media"],
	license: "MIT",
	sections: {
		description: "## Gallery\n\nBuild galleries. [Docs](https://trap.invalid/markdown)",
		installation: "Install from the registry.",
	},
	authors: [
		{
			name: "Example Publisher",
			url: "https://trap.invalid/author",
			email: "plugins@example.test",
		},
	],
	security: [
		{
			url: "https://trap.invalid/security",
			email: "security@example.test",
		},
	],
} as const satisfies RegistryRecords["com.emdashcms.experimental.package.profile"];

export function createReleaseRecord(mediaChecksum: string) {
	return {
		$type: "com.emdashcms.experimental.package.release",
		package: "gallery",
		version: "1.2.3",
		repo: "https://trap.invalid/repository",
		requires: { "env:emdash": ">=0.9.0", "env:astro": ">=6.0.0" },
		sbom: {
			format: "cyclonedx",
			url: "https://trap.invalid/sbom",
			checksum: "bafysbomtrap",
		},
		artifacts: {
			package: {
				url: "https://trap.invalid/package.tgz",
				checksum: "bafypackagetrap",
				contentType: "application/gzip",
			},
			icon: {
				url: "https://media.example/icon.png",
				checksum: mediaChecksum,
				contentType: "image/png",
				width: 1,
				height: 1,
			},
		},
		extensions: {
			"com.emdashcms.experimental.package.releaseExtension": {
				$type: "com.emdashcms.experimental.package.releaseExtension",
				declaredAccess: { network: { request: { origins: ["https://trap.invalid"] } } },
				provenance: {
					url: "https://trap.invalid/provenance",
					checksum: "bafyprovenancetrap",
					predicateType: "https://slsa.dev/provenance/v1",
					sourceRepository: "https://trap.invalid/source",
				},
			},
		},
	} satisfies RegistryRecords["com.emdashcms.experimental.package.release"];
}

export const PNG_BYTES = Uint8Array.from(
	atob(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	),
	(character) => character.charCodeAt(0),
);

export const ASSESSMENT_VERSIONS = {
	policyVersion: "listing-policy-v1",
	parserVersion: "canonical-input-v1",
	textModelId: "workers-ai-text-v1",
	textPromptHash: "sha256:text-prompt-v1",
	imageModelId: "workers-ai-image-v1",
	imagePromptHash: "sha256:image-prompt-v1",
} as const;
