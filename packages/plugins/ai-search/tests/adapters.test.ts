import { describe, expect, it } from "vitest";

import { BindingAiSearch } from "../src/adapters/binding.js";
import { RestAiSearch } from "../src/adapters/rest.js";

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

describe("RestAiSearch", () => {
	it("treats a rejected token as unauthorized, even when Cloudflare answers HTTP 400", async () => {
		const respond = (status: number, code: number) => async () =>
			Response.json(
				{ success: false, errors: [{ code, message: "Authentication failed" }] },
				{ status },
			);
		const credentials = { accountId: "account", apiToken: "token", namespace: "default" };

		await expect(
			new RestAiSearch(credentials, "emdash", respond(400, 9106)).verify(),
		).rejects.toMatchObject({
			reason: "unauthorized",
		});
		await expect(
			new RestAiSearch(credentials, "emdash", respond(404, 7063)).verify(),
		).rejects.toMatchObject({
			reason: "not-found",
		});
	});

	it("calls a token rejected only when both verify endpoints refuse it", async () => {
		const credentials = { accountId: "account", apiToken: "token", namespace: "default" };
		const verify = (answers: Record<string, Response>) =>
			new RestAiSearch(credentials, "emdash", async (input) => {
				const url = input instanceof Request ? input.url : input.toString();
				return url.includes("/accounts/") ? answers.account!.clone() : answers.user!.clone();
			}).tokenRejected();
		const refused = Response.json({ success: false, errors: [{ code: 1000 }] }, { status: 401 });
		const active = Response.json({ success: true, result: { status: "active" } });
		const limited = Response.json({ success: false, errors: [{ code: 10429 }] }, { status: 429 });

		expect(await verify({ account: refused, user: refused })).toBe(true);
		expect(await verify({ account: refused, user: active })).toBe(false);
		expect(await verify({ account: limited, user: refused })).toBe(false);
	});
});
