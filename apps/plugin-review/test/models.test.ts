import { afterEach, describe, expect, it, vi } from "vitest";

import { runReview } from "../src/agent.js";
import { gatewayReviewModel } from "../src/models.js";
import type { PluginReviewRequest } from "../src/types.js";

const ENV = {
	AI_GATEWAY_ACCOUNT_ID: "account",
	AI_GATEWAY_NAME: "gateway",
	AI_GATEWAY_TOKEN: "token",
};

const REQUEST: PluginReviewRequest = {
	model: "anthropic/claude-opus-5-5",
	subject: {
		uri: "at://did:plc:test/com.emdashcms.experimental.package.release/abc",
		cid: "bafy",
		version: "1.0.0",
	},
	listing: [],
	declaredAccess: {},
	files: [{ path: "backend.js", byteLength: 2, text: "{}" }],
};

const options = { signal: AbortSignal.timeout(5000), token: "T" };

function sse(events: { event: string; data: unknown }[], status = 200): Response {
	const body = events
		.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
		.join("");
	return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

const MESSAGE_START = {
	event: "message_start",
	data: {
		type: "message_start",
		message: {
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: "claude-opus-5-5",
			content: [],
			stop_reason: null,
			usage: { input_tokens: 10, output_tokens: 1 },
		},
	},
};

const POLICY_BLOCK =
	"This content was flagged for possible biological risk. If this seems wrong, try rephrasing your request.";

function openAIStreamError(type: string, code: string, message: string) {
	const error = { type, code, message, param: null };
	return [
		{
			event: "response.created",
			data: {
				type: "response.created",
				sequence_number: 0,
				response: { id: "resp_1", object: "response", status: "in_progress", output: [] },
			},
		},
		{ event: "error", data: { type: "error", error, sequence_number: 1 } },
		{
			event: "response.failed",
			data: {
				type: "response.failed",
				sequence_number: 2,
				response: { id: "resp_1", object: "response", status: "failed", error, output: [] },
			},
		},
	];
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("gatewayReviewModel", () => {
	it("returns a declined review when Anthropic refuses", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				sse([
					MESSAGE_START,
					{
						event: "message_delta",
						data: {
							type: "message_delta",
							delta: {
								stop_reason: "refusal",
								stop_details: { explanation: "Safeguards flagged this message." },
							},
							usage: { output_tokens: 1 },
						},
					},
					{ event: "message_stop", data: { type: "message_stop" } },
				]),
			),
		);

		const response = await runReview(REQUEST, gatewayReviewModel(ENV, REQUEST.model), options);

		expect(response).toMatchObject({
			model: REQUEST.model,
			declined: true,
			findings: [],
			summary: "Safeguards flagged this message.",
		});
	});

	it("still fails when Anthropic is overloaded mid-stream", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				sse([
					MESSAGE_START,
					{
						event: "error",
						data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
					},
				]),
			),
		);

		await expect(
			runReview(REQUEST, gatewayReviewModel(ENV, REQUEST.model), options),
		).rejects.toThrow(/overloaded/i);
	});

	it("returns a declined review when OpenAI blocks the request under a usage policy", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				sse(openAIStreamError("invalid_request_error", "bio_policy", POLICY_BLOCK)),
			),
		);
		const request = { ...REQUEST, model: "openai/gpt-6.1-sol" };

		const response = await runReview(request, gatewayReviewModel(ENV, request.model), options);

		expect(response).toMatchObject({
			model: request.model,
			declined: true,
			findings: [],
			summary: POLICY_BLOCK,
		});
	});

	it("still fails when OpenAI reports a server error mid-stream", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				sse(
					openAIStreamError(
						"server_error",
						"server_error",
						"An error occurred while processing your request.",
					),
				),
			),
		);
		const request = { ...REQUEST, model: "openai/gpt-6.1-sol" };

		await expect(
			runReview(request, gatewayReviewModel(ENV, request.model), options),
		).rejects.toThrow(/error occurred while processing/);
	});

	it("sends a requested reasoning level to Workers AI and none by default", async () => {
		const bodies: Record<string, unknown>[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init?: RequestInit) => {
				bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
				const chunk = {
					id: "c1",
					object: "chat.completion.chunk",
					created: 0,
					model: "@cf/zai-org/glm-5.3",
					choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
				};
				return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}),
		);
		const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };
		const signal = AbortSignal.timeout(5000);

		await gatewayReviewModel(ENV, "workers-ai/@cf/zai-org/glm-5.3", {
			reasoning: "low",
		}).complete(context, signal);
		await gatewayReviewModel(ENV, "workers-ai/@cf/zai-org/glm-5.3").complete(context, signal);

		expect(bodies[0]).toMatchObject({ model: "@cf/zai-org/glm-5.3", reasoning_effort: "low" });
		expect(bodies[1]).not.toHaveProperty("reasoning_effort");
	});
});
