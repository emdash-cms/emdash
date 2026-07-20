import { describe, expect, it } from "vitest";

import { RestAiBinding, type CallDiagnostics } from "./rest-ai-binding.js";

const RUN_INPUTS = {
	messages: [{ role: "system" as const, content: "hi" }],
	response_format: { type: "json_schema" as const, json_schema: { name: "f", schema: {} } },
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("RestAiBinding", () => {
	it("returns json.result verbatim, mimicking env.AI.run (production parseModelOutput does the unwrapping)", async () => {
		const result = {
			choices: [{ message: { content: '{"findings":[]}' }, finish_reason: "stop" }],
		};
		let seenUrl: string | undefined;
		let seenInit: RequestInit | undefined;
		const binding = new RestAiBinding({
			accountId: "acct",
			apiToken: "tok",
			fetchImpl: async (url, init) => {
				if (typeof url === "string") seenUrl = url;
				seenInit = init;
				return jsonResponse({ result, success: true });
			},
		});

		expect(await binding.run("@cf/x/model", RUN_INPUTS)).toEqual(result);
		expect(seenUrl).toBe("https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/x/model");
		const headers = seenInit?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer tok");
		expect(seenInit?.body).toBe(JSON.stringify(RUN_INPUTS));
	});

	it("reports diagnostics: finish reason, content and reasoning lengths, result keys", async () => {
		const result = {
			choices: [
				{ message: { content: "abc", reasoning_content: "reasoning" }, finish_reason: "length" },
			],
			usage: { total_tokens: 42 },
		};
		const captured: CallDiagnostics[] = [];
		const binding = new RestAiBinding({
			accountId: "acct",
			apiToken: "tok",
			fetchImpl: async () => jsonResponse({ result, success: true }),
			onCall: (value) => captured.push(value),
		});

		await binding.run("@cf/x/model", RUN_INPUTS);

		expect(captured[0]).toMatchObject({
			modelId: "@cf/x/model",
			finishReason: "length",
			contentLength: 3,
			reasoningLength: 9,
			resultKeys: ["choices", "usage"],
			usage: { total_tokens: 42 },
		});
	});

	it("throws when the envelope reports failure, and still emits diagnostics", async () => {
		const captured: CallDiagnostics[] = [];
		const binding = new RestAiBinding({
			accountId: "acct",
			apiToken: "tok",
			fetchImpl: async () => jsonResponse({ success: false, errors: [{ message: "nope" }] }, 400),
			onCall: (value) => captured.push(value),
		});

		await expect(binding.run("@cf/x/model", RUN_INPUTS)).rejects.toThrow(/HTTP 400/);
		expect(captured).toHaveLength(1);
	});

	it("rejects empty credentials", () => {
		expect(() => new RestAiBinding({ accountId: "", apiToken: "tok" })).toThrow(/accountId/);
		expect(() => new RestAiBinding({ accountId: "acct", apiToken: "  " })).toThrow(/apiToken/);
	});
});
