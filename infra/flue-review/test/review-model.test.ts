import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { resetProviderRuntime, resolveModel } from "@flue/runtime/internal";
import { afterEach, describe, expect, it, vi } from "vitest";

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
		expect(opus.baseUrl).toBe("https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic");
		expect(opus.headers).toMatchObject({ "cf-aig-authorization": "Bearer token" });
		expect(opus.maxTokens).toBeGreaterThan(0);

		const sol = resolveModel("openai/gpt-6.1-sol");
		expect(sol.baseUrl).toBe("https://gateway.ai.cloudflare.com/v1/account/gateway/openai");
		expect(sol.contextWindow).toBe(opus.contextWindow);
	});

	it.each([
		[
			"anthropic/claude-opus-5-5",
			{ thinking: { type: "adaptive" }, output_config: { effort: "medium" } },
		],
		[
			"openai/gpt-6.1-sol",
			{ reasoning: { effort: "medium" }, include: ["reasoning.encrypted_content"] },
		],
	])("sends the thinking level for %s", async (specifier, expected) => {
		registerGatewayProviders(GATEWAY);
		const model = resolveModel(specifier);
		const bodies: unknown[] = [];
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
			bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
			return new Response(JSON.stringify({ error: { message: "stop" } }), { status: 400 });
		});
		vi.stubGlobal("fetch", fetchMock);
		try {
			const provider = getApiProvider(model.api);
			const events = provider?.streamSimple(
				model,
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{ apiKey: "token", reasoning: "medium" },
			);
			for await (const _event of events ?? []) {
				// Drain until the stubbed error ends the stream.
			}
		} finally {
			vi.unstubAllGlobals();
		}
		expect(bodies[0]).toMatchObject(expected);
	});
});
