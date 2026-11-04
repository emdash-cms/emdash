import type {
	CanonicalProfileModerationInput,
	CanonicalReleaseModerationInput,
} from "../inputs.js";

export const FIXTURE_PUBLISHER_DID = "did:plc:listingfixture000000000000";
export const FIXTURE_PROFILE_URI = `at://${FIXTURE_PUBLISHER_DID}/com.emdashcms.experimental.package.profile/gallery`;
export const FIXTURE_RELEASE_URI = `at://${FIXTURE_PUBLISHER_DID}/com.emdashcms.experimental.package.release/gallery:1.2.3`;
export const FIXTURE_PROFILE_CID = "bafyreiabaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibae";
export const FIXTURE_RELEASE_CID = "bafyreiacaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcai";

export const PROFILE_MODERATION_INPUT_FIXTURE = {
	schemaVersion: 1,
	subject: { uri: FIXTURE_PROFILE_URI, cid: FIXTURE_PROFILE_CID, kind: "profile" },
	publisherDid: FIXTURE_PUBLISHER_DID,
	slug: "gallery",
	name: "Gallery",
	description: "A media gallery for EmDash.",
	keywords: ["gallery", "media"],
	license: "MIT",
	sections: {
		description: "## Gallery\n\nBuild galleries.",
		installation: "Install from the plugin registry.",
		faq: "Frequently asked questions.",
		changelog: "Version history.",
		security: "Report security issues privately.",
	},
	authors: [
		{
			name: "Example Publisher",
			url: "https://publisher.example/about",
			email: "plugins@publisher.example",
		},
	],
	security: [
		{
			url: "https://publisher.example/security",
			email: "security@publisher.example",
		},
	],
	lastUpdated: "2026-08-24T00:00:00.000Z",
} as const satisfies CanonicalProfileModerationInput;

export const RELEASE_MODERATION_INPUT_FIXTURE = {
	schemaVersion: 1,
	subject: { uri: FIXTURE_RELEASE_URI, cid: FIXTURE_RELEASE_CID, kind: "release" },
	publisherDid: FIXTURE_PUBLISHER_DID,
	packageSlug: "gallery",
	version: "1.2.3",
	repositoryUrl: "https://code.example/publisher/gallery",
	requires: { "env:emdash": ">=0.9.0", "env:astro": ">=6.0.0" },
	sbom: { format: "cyclonedx", url: "https://downloads.example/gallery/sbom.json" },
	media: [
		{
			kind: "icon",
			index: 0,
			id: "icon",
			url: "https://media.example/gallery/icon.png",
			checksum: "bafkiconchecksum",
			contentType: "image/png",
			width: 512,
			height: 512,
			language: "en",
			verified: {
				sha256: "11".repeat(32),
				mimeType: "image/png",
				byteLength: 1024,
				width: 512,
				height: 512,
				contentRef: "quarantine://media/icon",
			},
		},
		{
			kind: "banner",
			index: 0,
			url: "https://media.example/gallery/banner.webp",
			checksum: "bafkbannerchecksum",
		},
		{
			kind: "screenshot",
			index: 0,
			url: "https://media.example/gallery/screenshot-1.webp",
			checksum: "bafkscreenshotchecksum",
		},
	],
} as const satisfies CanonicalReleaseModerationInput;

export const MODERATION_INPUT_FIELDS_FIXTURE = {
	profile: [
		"slug",
		"name",
		"description",
		"keywords",
		"license",
		"sections",
		"authors.name",
		"authors.url",
		"authors.email",
		"security.url",
		"security.email",
		"lastUpdated",
	],
	release: [
		"packageSlug",
		"version",
		"repositoryUrl",
		"requires.keys",
		"requires.constraints",
		"sbom.format",
		"sbom.url",
		"media.icon",
		"media.banner",
		"media.screenshot",
	],
} as const;
