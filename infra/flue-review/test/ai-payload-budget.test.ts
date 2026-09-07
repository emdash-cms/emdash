import { describe, expect, it, vi } from "vitest";

import { createAiPayloadGuard } from "../.flue/lib/ai-payload-budget.js";

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
});
