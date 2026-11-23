import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
	CodeAssessmentConfigurationError,
	createProductionCodeAssessment,
} from "../src/code/runtime.js";

const options = {
	db: env.DB,
	resolver: { resolve: async () => [] },
	transport: { fetch: async () => new Response(null, { status: 404 }) },
} as unknown as Parameters<typeof createProductionCodeAssessment>[1];
const reviewer = { review: async () => ({}) };

describe("production code assessment configuration", () => {
	it("stays off until reviewer models are configured", () => {
		expect(createProductionCodeAssessment({ PLUGIN_REVIEW: reviewer }, options)).toBeUndefined();
	});

	it("refuses to run without the review Worker once models are configured", () => {
		expect(() =>
			createProductionCodeAssessment(
				{ LABELER_CODE_REVIEW_MODELS: "anthropic/claude-opus-5-5" },
				options,
			),
		).toThrow(CodeAssessmentConfigurationError);
	});

	it.each([
		["an invalid model list", { LABELER_CODE_REVIEW_MODELS: "not a model" }],
		[
			"a non-positive budget",
			{
				LABELER_CODE_REVIEW_MODELS: "anthropic/claude-opus-5-5",
				LABELER_CODE_REVIEW_DAILY_LIMIT: "0",
			},
		],
	])("rejects %s", (_name, settings) => {
		expect(() =>
			createProductionCodeAssessment({ ...settings, PLUGIN_REVIEW: reviewer }, options),
		).toThrow(CodeAssessmentConfigurationError);
	});

	it("deduplicates the configured models", () => {
		const assessment = createProductionCodeAssessment(
			{
				LABELER_CODE_REVIEW_MODELS:
					"anthropic/claude-opus-5-5, openai/gpt-6.1-sol,anthropic/claude-opus-5-5",
				PLUGIN_REVIEW: reviewer,
			},
			options,
		);
		expect(assessment?.models).toEqual(["anthropic/claude-opus-5-5", "openai/gpt-6.1-sol"]);
	});
});
