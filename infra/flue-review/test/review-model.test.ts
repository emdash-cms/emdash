import { resetProviderRuntime, resolveModel } from "@flue/runtime/internal";
import { afterEach, describe, expect, it } from "vitest";

import {
	DEFAULT_REVIEW_MODEL,
	registerGatewayProviders,
	reviewModel,
} from "../.flue/lib/review-model.js";

const GATEWAY = {
	AI_GATEWAY_ACCOUNT_ID: "account",
	AI_GATEWAY_NAME: "gateway",
	AI_GATEWAY_TOKEN: "token",
};

describe("reviewModel", () => {
	it("defaults to Kimi when no model is configured", () => {
		expect(reviewModel({})).toBe(DEFAULT_REVIEW_MODEL);
		expect(reviewModel({ REVIEW_MODEL: "  " })).toBe(DEFAULT_REVIEW_MODEL);
	});

	it("uses the configured model", () => {
		expect(reviewModel({ REVIEW_MODEL: "anthropic/claude-opus-5-5" })).toBe(
			"anthropic/claude-opus-5-5",
		);
	});
});

describe("registerGatewayProviders", () => {
	afterEach(() => resetProviderRuntime());

	it("registers nothing without complete gateway settings", () => {
		expect(registerGatewayProviders({})).toBe(false);
		expect(registerGatewayProviders({ ...GATEWAY, AI_GATEWAY_TOKEN: "" })).toBe(false);
		expect(() => resolveModel("anthropic/claude-opus-5-5")).toThrow(/Unknown model specifier/);
		expect(() => resolveModel("openai/gpt-6.1-sol")).toThrow(/Unknown model specifier/);
	});

	it("routes Anthropic and OpenAI models through the authenticated gateway", () => {
		expect(registerGatewayProviders(GATEWAY)).toBe(true);

		const opus = resolveModel("anthropic/claude-opus-5-5");
		expect(opus.api).toBe("anthropic-messages");
		expect(opus.baseUrl).toBe("https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic");
		expect(opus.headers).toMatchObject({ "cf-aig-authorization": "Bearer token" });
		expect(opus.maxTokens).toBeGreaterThan(0);

		const sol = resolveModel("openai/gpt-6.1-sol");
		expect(sol.api).toBe("openai-responses");
		expect(sol.baseUrl).toBe("https://gateway.ai.cloudflare.com/v1/account/gateway/openai");
		expect(sol.contextWindow).toBe(opus.contextWindow);
	});
});
