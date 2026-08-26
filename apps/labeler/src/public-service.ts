import { INITIAL_LISTING_POLICY_FIXTURE } from "@emdash-cms/registry-moderation/fixtures";

import { readPublicLabelerRuntimeConfig } from "./runtime-config.js";

export function labelerDidDocument(env: Env): Response {
	const config = readPublicLabelerRuntimeConfig(env);
	return Response.json(
		{
			"@context": ["https://www.w3.org/ns/did/v1"],
			id: config.labelerDid,
			verificationMethod: [
				{
					id: `${config.labelerDid}#atproto_label`,
					type: "Multikey",
					controller: config.labelerDid,
					publicKeyMultibase: config.publicKeyMultibase,
				},
			],
			service: [
				{
					id: `${config.labelerDid}#atproto_labeler`,
					type: "AtprotoLabeler",
					serviceEndpoint: config.serviceUrl,
				},
			],
		},
		{ headers: { "cache-control": "public, max-age=300" } },
	);
}

export function labelerPolicyDocument(env: Env): Response {
	const config = readPublicLabelerRuntimeConfig(env);
	return Response.json(
		{
			schemaVersion: 1,
			labelerDid: config.labelerDid,
			policyVersion: config.versions.policyVersion,
			effectiveAt: INITIAL_LISTING_POLICY_FIXTURE.effectiveAt,
			autoPass: "disabled",
			subjectCollections: [
				"com.emdashcms.experimental.package.profile",
				"com.emdashcms.experimental.package.release",
			],
			labels: [
				"listing-passed",
				"listing-pending",
				"listing-review",
				"listing-error",
				"listing-blocked",
				"listing-overridden",
				"!takedown",
			],
			parserVersion: config.versions.parserVersion,
			models: {
				text: {
					modelId: config.versions.textModelId,
					promptHash: config.versions.textPromptHash,
				},
				image: {
					modelId: config.versions.imageModelId,
					promptHash: config.versions.imagePromptHash,
				},
			},
		},
		{ headers: { "cache-control": "public, max-age=300" } },
	);
}
