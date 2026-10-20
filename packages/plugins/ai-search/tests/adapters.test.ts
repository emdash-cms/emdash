import { describe, expect, it } from "vitest";

import { BindingAiSearch } from "../src/adapters/binding.js";

describe("BindingAiSearch", () => {
	it("reports the binding's rate-limit and not-found errors by reason", async () => {
		const instance = {
			items: {
				upload: async () => {
					throw new Error("AiSearchError: You are being rate limited.");
				},
			},
			stats: async () => {
				throw new Error("AiSearchNotFoundError: ai_search_not_found");
			},
		};
		const namespace = { get: () => instance } as unknown as AiSearchNamespace;
		const provider = new BindingAiSearch(namespace, "emdash");

		await expect(provider.uploadItem("posts/a.md", "", {})).rejects.toMatchObject({
			reason: "rate-limited",
		});
		await expect(provider.stats()).rejects.toMatchObject({ reason: "not-found" });
	});
});
