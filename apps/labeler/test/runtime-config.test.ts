import { describe, expect, it } from "vitest";

import { IMAGE_PROMPT_HASH, TEXT_PROMPT_HASH } from "../src/ai/prompts.js";
import { readLabelerRuntimeConfig } from "../src/runtime-config.js";

const ENV = {
	LABELER_DID: "did:web:labels.emdashcms.com",
	LABELER_SERVICE_URL: "https://labels.emdashcms.com",
	LABEL_SIGNING_PRIVATE_KEY: "private-key",
	LABEL_SIGNING_PUBLIC_KEY: "zDnaepsL7AXenJkVYdkh5KuKsSU7Ykh7kyXaLLU7auN9FWSiZ",
	LABELER_POLICY_VERSION: "listing-metadata-v1",
	LABELER_PARSER_VERSION: "canonical-listing-input-v1",
	LABELER_TEXT_MODEL_ID: "@cf/text",
	LABELER_IMAGE_MODEL_ID: "@cf/image",
};

describe("labeler runtime configuration", () => {
	it("parses exact manual-enforcement model, policy, identity, and signing inputs", async () => {
		const config = await readLabelerRuntimeConfig(ENV);
		expect(config).toEqual({
			labelerDid: ENV.LABELER_DID,
			serviceUrl: ENV.LABELER_SERVICE_URL,
			privateKey: ENV.LABEL_SIGNING_PRIVATE_KEY,
			publicKeyMultibase: ENV.LABEL_SIGNING_PUBLIC_KEY,
			versions: {
				policyVersion: ENV.LABELER_POLICY_VERSION,
				parserVersion: ENV.LABELER_PARSER_VERSION,
				textModelId: ENV.LABELER_TEXT_MODEL_ID,
				textPromptHash: TEXT_PROMPT_HASH,
				imageModelId: ENV.LABELER_IMAGE_MODEL_ID,
				imagePromptHash: IMAGE_PROMPT_HASH,
			},
		});
	});

	it("rejects a DID/service mismatch", async () => {
		await expect(
			readLabelerRuntimeConfig({ ...ENV, LABELER_SERVICE_URL: "https://other.example" }),
		).rejects.toThrow(/must match/);
	});

	it("reads a secret binding without exposing it in ordinary configuration", async () => {
		const get = async () => "secret-store-private-key";
		await expect(
			readLabelerRuntimeConfig({ ...ENV, LABEL_SIGNING_PRIVATE_KEY: { get } }),
		).resolves.toMatchObject({ privateKey: "secret-store-private-key" });
	});
});
