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
});
