import { describe, expect, it, vi } from "vitest";

import { createRemoteSweepBinding } from "../evals/sweep-client.js";

describe("remote model sweep binding", () => {
	it("propagates the production adapter abort signal to the sweep request", async () => {
		const controller = new AbortController();
		const reason = new Error("inference deadline exceeded");
		const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			expect(init?.signal).toBe(controller.signal);
			throw init?.signal?.reason;
		});
		const binding = createRemoteSweepBinding("https://sweep.test", { fetch });
		controller.abort(reason);

		await expect(
			binding.run("@cf/example/model", { messages: [] }, { signal: controller.signal }),
		).rejects.toBe(reason);
		expect(fetch).toHaveBeenCalledOnce();
	});
});
