import { describe, expect, it, vi } from "vitest";

import { createAiPayloadGuard, summarizeAiPayload } from "../.flue/lib/ai-payload-budget.js";

describe("createAiPayloadGuard", () => {
	it("rejects a megabyte-scale request before it reaches Workers AI", async () => {
		const run = vi.fn().mockResolvedValue({ response: "ok" });
		const guarded = createAiPayloadGuard({ run });

		await expect(
			guarded.run("model", { messages: [{ content: "x".repeat(1024 * 1024) }] }),
		).rejects.toThrow(/model-request budget/);
		expect(run).not.toHaveBeenCalled();
	});

	it("passes a large but bounded review context through unchanged", async () => {
		const response = { response: "ok" };
		const run = vi.fn().mockResolvedValue(response);
		const guarded = createAiPayloadGuard({ run });
		const input = { messages: [{ content: "x".repeat(512 * 1024) }] };
		const options = { returnRawResponse: true };

		await expect(guarded.run("model", input, options)).resolves.toBe(response);
		expect(run).toHaveBeenCalledWith("model", input, options);
	});

	it("reports size-only attribution for every model request", async () => {
		const run = vi.fn().mockResolvedValue({ response: "ok" });
		const report = vi.fn();
		const guarded = createAiPayloadGuard({ run }, 1024 * 1024, report);
		const secret = "do-not-log-this-content";
		const input = {
			messages: [
				{ role: "system", content: secret },
				{ role: "tool", content: secret },
			],
			tools: [{ type: "function", function: { name: "code", description: secret } }],
		};

		await guarded.run("model", input);

		expect(report).toHaveBeenCalledWith(summarizeAiPayload(input), 1024 * 1024, false);
		expect(report.mock.calls[0]?.[0]).not.toHaveProperty("content");
		expect(JSON.stringify(report.mock.calls[0]?.[0])).not.toContain(secret);
	});

	it("does not let diagnostics break model requests", async () => {
		const response = { response: "ok" };
		const run = vi.fn().mockResolvedValue(response);
		const guarded = createAiPayloadGuard({ run }, 1024 * 1024, () => {
			throw new Error("logger unavailable");
		});

		await expect(guarded.run("model", { messages: [] })).resolves.toBe(response);
	});

	it("marks rejected request diagnostics without forwarding the request", async () => {
		const run = vi.fn().mockResolvedValue({ response: "ok" });
		const report = vi.fn();
		const guarded = createAiPayloadGuard({ run }, 100, report);
		const input = { messages: [{ role: "user", content: "é".repeat(100) }] };

		await expect(guarded.run("model", input)).rejects.toThrow(/model-request budget/);

		expect(report).toHaveBeenCalledWith(summarizeAiPayload(input), 100, true);
		expect(run).not.toHaveBeenCalled();
	});

	it("keeps a PR 3185-shaped review below budget when the compiled bundle is omitted", async () => {
		const run = vi.fn().mockResolvedValue({ response: "ok" });
		const guarded = createAiPayloadGuard({ run }, 1024 * 1024, vi.fn());
		const baseMessages = [
			{ role: "system", content: "x".repeat(70_000) },
			{ role: "tool", content: "x".repeat(186_294) },
			{ role: "tool", content: "x".repeat(164_339) },
			{ role: "tool", content: "x".repeat(116_082) },
			{ role: "tool", content: "x".repeat(120_837) },
		];
		const withCompiledBundle = {
			messages: [...baseMessages, { role: "tool", content: "x".repeat(476_652) }],
		};
		const withCompiledMarker = {
			messages: [
				...baseMessages,
				{
					role: "tool",
					content:
						"(compiled release-action artifact changed; contents omitted from model review context)",
				},
			],
		};

		await expect(guarded.run("model", withCompiledBundle)).rejects.toThrow(/model-request budget/);
		await expect(guarded.run("model", withCompiledMarker)).resolves.toEqual({ response: "ok" });
		expect(run).toHaveBeenCalledTimes(1);
	});
});
