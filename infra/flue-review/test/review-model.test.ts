import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { resetProviderRuntime, resolveModel } from "@flue/runtime/internal";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	completeWithGateway,
	DEFAULT_MERGE_MODEL,
	DEFAULT_REVIEW_MODEL,
	registerGatewayProviders,
	reviewModel,
	reviewPlan,
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

describe("reviewPlan", () => {
	it("reviews with Kimi alone and no merge without the gateway", () => {
		expect(reviewPlan({})).toEqual({ reviewers: [DEFAULT_REVIEW_MODEL] });
		expect(reviewPlan({ ...GATEWAY, AI_GATEWAY_NAME: "" })).toEqual({
			reviewers: [DEFAULT_REVIEW_MODEL],
		});
		expect(reviewPlan({ REVIEW_MODELS: "anthropic/claude-opus-5-5,openai/gpt-6.1-sol" })).toEqual({
			reviewers: [DEFAULT_REVIEW_MODEL],
		});
	});

	it("defaults to Opus and Sol merged by Sonnet with the gateway", () => {
		expect(reviewPlan(GATEWAY)).toEqual({
			reviewers: ["anthropic/claude-opus-5-5", "openai/gpt-6.1-sol"],
			mergeModel: DEFAULT_MERGE_MODEL,
		});
	});

	it("follows up with Sol alone, and full reviews keep the panel", () => {
		expect(reviewPlan(GATEWAY, { followUp: true })).toEqual({
			reviewers: ["openai/gpt-6.1-sol"],
			mergeModel: DEFAULT_MERGE_MODEL,
		});
		expect(
			reviewPlan(
				{ ...GATEWAY, REVIEW_FOLLOWUP_MODELS: "anthropic/claude-opus-5-5" },
				{ followUp: true },
			).reviewers,
		).toEqual(["anthropic/claude-opus-5-5"]);
		expect(reviewPlan(GATEWAY, { followUp: false }).reviewers).toEqual([
			"anthropic/claude-opus-5-5",
			"openai/gpt-6.1-sol",
		]);
		expect(reviewPlan({}, { followUp: true })).toEqual({ reviewers: [DEFAULT_REVIEW_MODEL] });
	});

	it("reads the reviewer list and merge model from configuration", () => {
		expect(
			reviewPlan({
				...GATEWAY,
				REVIEW_MODELS: " openai/gpt-6.1-sol, anthropic/claude-opus-5-5,,openai/gpt-6.1-sol ",
				REVIEW_MERGE_MODEL: "openai/gpt-5.6-luna",
			}),
		).toEqual({
			reviewers: ["openai/gpt-6.1-sol", "anthropic/claude-opus-5-5"],
			mergeModel: "openai/gpt-5.6-luna",
		});
		expect(reviewPlan({ ...GATEWAY, REVIEW_MODEL: "anthropic/claude-opus-5-5" }).reviewers).toEqual(
			["anthropic/claude-opus-5-5"],
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
			"anthropic/claude-sonnet-5-5",
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

describe("completeWithGateway", () => {
	function stubAnthropic(response: Response) {
		const requests: Array<{ url: string; body: unknown; headers: Headers }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init);
				requests.push({
					url: request.url,
					body: JSON.parse(await request.text()),
					headers: request.headers,
				});
				return response;
			}),
		);
		return requests;
	}

	afterEach(() => vi.unstubAllGlobals());

	it("sends one tool-less request at low effort through the gateway", async () => {
		const sse = [
			'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"claude-sonnet-5-5","content":[],"stop_reason":null,"usage":{"input_tokens":1000,"output_tokens":1}}}',
			'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\\"verdict\\":\\"approve\\"}"}}',
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":100}}',
			'event: message_stop\ndata: {"type":"message_stop"}',
		].join("\n\n");
		const requests = stubAnthropic(
			new Response(`${sse}\n\n`, { headers: { "content-type": "text/event-stream" } }),
		);
		const { text, usage } = await completeWithGateway(
			GATEWAY,
			"anthropic/claude-sonnet-5-5",
			"Merge these reviews.",
			{ reasoning: "low" },
		);
		expect(text).toBe('{"verdict":"approve"}');
		expect(usage.output).toBe(100);
		expect(usage.cost.total).toBeCloseTo((1000 * 2 + 100 * 10) / 1_000_000);
		const [request] = requests;
		expect(request?.url).toBe(
			"https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic/v1/messages",
		);
		expect(request?.headers.get("cf-aig-authorization")).toBe("Bearer token");
		expect(request?.body).toMatchObject({
			model: "claude-sonnet-5-5",
			thinking: { type: "adaptive" },
			output_config: { effort: "low" },
		});
		expect(request?.body).not.toHaveProperty("tools");
	});

	it("throws the provider error so capacity errors can be retried", async () => {
		stubAnthropic(
			new Response(
				JSON.stringify({
					type: "error",
					error: { type: "overloaded_error", message: "Overloaded" },
				}),
				{ status: 529 },
			),
		);
		await expect(
			completeWithGateway(GATEWAY, "anthropic/claude-sonnet-5-5", "Merge."),
		).rejects.toThrow(/overloaded/i);
	});

	it("refuses models outside the gateway", async () => {
		await expect(completeWithGateway(GATEWAY, DEFAULT_REVIEW_MODEL, "Merge.")).rejects.toThrow(
			/not an AI Gateway model/,
		);
		await expect(completeWithGateway({}, "anthropic/claude-sonnet-5-5", "Merge.")).rejects.toThrow(
			/settings are missing/,
		);
	});
});
