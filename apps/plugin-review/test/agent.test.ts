import type { AssistantMessage, Context, ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { ReviewFailedError, runReview, type ReviewModel } from "../src/agent.js";
import { PROMPT_VERSION } from "../src/prompt.js";
import type { PluginReviewRequest } from "../src/types.js";

const BACKEND = [
	"export default {",
	'\troutes: { stats: { public: true, handler: async (ctx) => ctx.content.list("posts", { status: "draft" }) } },',
	"};",
].join("\n");

const REQUEST: PluginReviewRequest = {
	model: "anthropic/test-model",
	subject: {
		uri: "at://did:plc:test/com.emdashcms.experimental.package.release/abc",
		cid: "bafy",
		version: "1.0.0",
	},
	listing: [{ ref: "profile.description", text: "Shows public post counts." }],
	declaredAccess: { content: { read: true } },
	files: [
		{ path: "manifest.json", byteLength: 2, text: "{}" },
		{ path: "backend.js", byteLength: BACKEND.length, text: BACKEND },
		{ path: "icon.png", byteLength: 4 },
	],
};

type Turn = (context: Context) => ToolCall[] | Partial<AssistantMessage>;

function scriptedModel(turns: Turn[]): ReviewModel & { contexts: Context[] } {
	const contexts: Context[] = [];
	return {
		id: REQUEST.model,
		contexts,
		async complete(context) {
			contexts.push(structuredClone(context));
			const turn = turns.shift();
			if (!turn) throw new Error("script ran out of turns");
			const result = turn(context);
			const overrides = Array.isArray(result)
				? { content: result, stopReason: "toolUse" as const }
				: result;
			return {
				role: "assistant",
				content: [],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test-model",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 0,
				...overrides,
			};
		},
	};
}

let callId = 0;
function call(name: string, args: Record<string, unknown> = {}): ToolCall {
	callId += 1;
	return { type: "toolCall", id: `call-${callId}`, name, arguments: args };
}

const readAll: Turn = () => [
	call("read_file", { path: "manifest.json" }),
	call("read_file", { path: "backend.js" }),
];

const VULNERABILITY = {
	category: "vulnerability",
	severity: "high",
	confidence: 0.8,
	summary: "A public route returns draft posts to anyone.",
	evidence: [
		{ file: "backend.js", line: 2, quote: 'ctx.content.list("posts", { status: "draft" })' },
	],
};

function lastToolResult(context: Context) {
	const message = context.messages.at(-1);
	if (message?.role !== "toolResult") throw new Error("expected a tool result");
	return message;
}

const options = { signal: new AbortController().signal, token: "run-token" };

describe("runReview", () => {
	it("returns an accepted submission with the model and prompt version", async () => {
		const model = scriptedModel([
			readAll,
			() => [call("submit_review", { summary: "Counts posts.", findings: [VULNERABILITY] })],
		]);

		const response = await runReview(REQUEST, model, options);

		expect(response).toEqual({
			model: REQUEST.model,
			promptVersion: PROMPT_VERSION,
			summary: "Counts posts.",
			findings: [VULNERABILITY],
		});
	});

	it("fences the publisher's listing text and declared access", async () => {
		const model = scriptedModel([
			readAll,
			() => [call("submit_review", { summary: "Clean.", findings: [] })],
		]);

		await runReview(REQUEST, model, options);

		const opening = model.contexts[0]?.messages[0];
		expect(opening?.role).toBe("user");
		expect(opening?.content).toContain(
			"<<<BUNDLE run-token>>>\n[profile.description]\nShows public post counts.\n<<<END BUNDLE run-token>>>",
		);
	});

	it("rejects a submission before every text file is read, then accepts it", async () => {
		const model = scriptedModel([
			() => [call("submit_review", { summary: "Clean.", findings: [] })],
			(context) => {
				const result = lastToolResult(context);
				expect(result.isError).toBe(true);
				expect(result.content).toEqual([
					expect.objectContaining({ text: expect.stringContaining("Unread: manifest.json") }),
				]);
				return readAll(context);
			},
			() => [call("submit_review", { summary: "Clean.", findings: [] })],
		]);

		const response = await runReview(REQUEST, model, options);

		expect(response.findings).toEqual([]);
	});

	it("rejects a submission sent in the same message as the reads it depends on", async () => {
		const model = scriptedModel([
			(context) => [
				...(readAll(context) as ToolCall[]),
				call("submit_review", { summary: "Clean.", findings: [] }),
			],
			(context) => {
				const result = lastToolResult(context);
				expect(result.toolName).toBe("submit_review");
				expect(result.isError).toBe(true);
				return [call("submit_review", { summary: "Counts posts.", findings: [VULNERABILITY] })];
			},
		]);

		const response = await runReview(REQUEST, model, options);

		expect(response.findings).toEqual([VULNERABILITY]);
	});

	it("rejects a citation whose quote is not on the cited line", async () => {
		const misquoted = {
			...VULNERABILITY,
			evidence: [{ file: "backend.js", line: 1, quote: "ctx.content.list" }],
		};
		const model = scriptedModel([
			readAll,
			() => [call("submit_review", { summary: "Found one.", findings: [misquoted] })],
			(context) => {
				expect(lastToolResult(context).content).toEqual([
					expect.objectContaining({
						text: expect.stringContaining("does not appear on backend.js line 1"),
					}),
				]);
				return [call("submit_review", { summary: "Found one.", findings: [VULNERABILITY] })];
			},
		]);

		const response = await runReview(REQUEST, model, options);

		expect(response.findings).toEqual([VULNERABILITY]);
	});

	it("fails after three invalid submissions", async () => {
		const invalid = () => [
			call("submit_review", { summary: "Clean.", findings: [{ category: "style" }] }),
		];
		const model = scriptedModel([readAll, invalid, invalid, invalid]);

		await expect(runReview(REQUEST, model, options)).rejects.toThrow(ReviewFailedError);
	});

	it("returns tool input errors to the model instead of failing", async () => {
		const model = scriptedModel([
			() => [call("read_file", { path: "icon.png" })],
			(context) => {
				expect(lastToolResult(context).isError).toBe(true);
				return readAll(context);
			},
			() => [call("submit_review", { summary: "Clean.", findings: [] })],
		]);

		await expect(runReview(REQUEST, model, options)).resolves.toMatchObject({ findings: [] });
	});

	it("fails when the model stops answering with tools", async () => {
		const text = () => ({ content: [{ type: "text" as const, text: "I cannot help with that." }] });
		const model = scriptedModel([text, text, text]);

		await expect(runReview(REQUEST, model, options)).rejects.toThrow("stopped without submitting");
	});

	it("fails when the provider reports an error", async () => {
		const model = scriptedModel([() => ({ stopReason: "error", errorMessage: "overloaded" })]);

		await expect(runReview(REQUEST, model, options)).rejects.toThrow("overloaded");
	});
});
