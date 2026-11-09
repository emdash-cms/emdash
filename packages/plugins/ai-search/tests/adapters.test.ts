import { describe, expect, it } from "vitest";

import { BindingAiSearch } from "../src/adapters/binding.js";
import { RestAiSearch } from "../src/adapters/rest.js";

const credentials = { accountId: "account", apiToken: "token", namespace: "default" };
const INSTANCE_URL =
	"https://api.cloudflare.com/client/v4/accounts/account/ai-search/namespaces/default/instances";

/** A REST adapter whose requests `respond` answers, keeping each request it received. */
function restWith(respond: (request: Request) => Response | Promise<Response>) {
	const requests: Request[] = [];
	const provider = new RestAiSearch(credentials, "emdash", async (input, init) => {
		requests.push(new Request(input, init));
		return respond(new Request(input, init));
	});
	return { provider, requests };
}

const failure = (status: number) =>
	Response.json({ success: false, errors: [{ code: 1, message: "refused" }] }, { status });

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

describe("ensureInstance", () => {
	it.each([
		["AiSearchError: You are being rate limited.", "rate-limited"],
		["Internal error", "failed"],
	])("binding: rethrows %s without creating the instance", async (message, reason) => {
		let created = 0;
		const namespace = {
			get: () => ({
				info: async () => {
					throw new Error(message);
				},
			}),
			create: async () => void created++,
		} as unknown as AiSearchNamespace;

		await expect(new BindingAiSearch(namespace, "emdash").ensureInstance()).rejects.toMatchObject({
			reason,
		});
		expect(created).toBe(0);
	});

	it("binding: reuses an existing instance and creates a missing one", async () => {
		const names: string[] = [];
		let exists = true;
		const namespace = {
			get: () => ({
				info: async () => {
					if (!exists) throw new Error("AiSearchNotFoundError: ai_search_not_found");
					return { id: "emdash" };
				},
			}),
			create: async (config: { id: string }) => void names.push(config.id),
		} as unknown as AiSearchNamespace;
		const provider = new BindingAiSearch(namespace, "emdash");

		expect(await provider.ensureInstance()).toEqual({ created: false });
		exists = false;
		expect(await provider.ensureInstance()).toEqual({ created: true });
		expect(names).toEqual(["emdash"]);
	});

	it.each([
		[401, "unauthorized"],
		[429, "rate-limited"],
		[500, "failed"],
	])("REST: rethrows HTTP %i without creating the instance", async (status, reason) => {
		const { provider, requests } = restWith(() => failure(status));

		await expect(provider.ensureInstance()).rejects.toMatchObject({ reason });
		expect(requests.map((request) => request.method)).toEqual(["GET"]);
	});

	it("REST: reuses an existing instance and creates a missing one", async () => {
		const existing = restWith(() => Response.json({ success: true, result: { id: "emdash" } }));
		expect(await existing.provider.ensureInstance()).toEqual({ created: false });
		expect(existing.requests).toHaveLength(1);

		const missing = restWith((request) =>
			request.method === "GET" ? failure(404) : Response.json({ success: true, result: {} }),
		);
		expect(await missing.provider.ensureInstance()).toEqual({ created: true });
		const create = missing.requests[1]!;
		expect([create.method, create.url]).toEqual(["POST", INSTANCE_URL]);
		expect(await create.json()).toMatchObject({ id: "emdash" });
	});
});

describe("RestAiSearch", () => {
	it("maps item listing, upload and search to the Cloudflare API", async () => {
		const item = {
			id: "1",
			key: "posts/a.md",
			status: "completed",
			metadata: { title: "A" },
			last_seen_at: "2026-01-02 03:04:05",
		};
		const { provider, requests } = restWith((request) => {
			if (request.url.includes("/search")) {
				return Response.json({ success: true, result: { chunks: [{ item }] } });
			}
			if (request.method === "POST") return Response.json({ success: true, result: item });
			return Response.json({ success: true, result: [item], result_info: { total_count: 7 } });
		});

		expect(
			await provider.listItems({ status: "error", metadata: { folder: "posts" }, perPage: 1 }),
		).toEqual({
			items: [
				{
					id: "1",
					key: "posts/a.md",
					status: "completed",
					metadata: { title: "A" },
					updatedAt: "2026-01-02T03:04:05Z",
				},
			],
			total: 7,
		});
		const listed = new URL(requests[0]!.url);
		expect(listed.pathname).toMatch(/\/instances\/emdash\/items$/);
		expect(Object.fromEntries(listed.searchParams)).toEqual({
			status: "error",
			metadata_filter: '{"folder":"posts"}',
			per_page: "1",
		});

		await provider.uploadItem("posts/a.md", "# A", { title: "A" });
		const form = await requests[1]!.formData();
		const file = form.get("file") as File;
		expect([file.name, await file.text(), form.get("metadata")]).toEqual([
			"posts/a.md",
			"# A",
			'{"title":"A"}',
		]);

		expect(await provider.search({ query: "hello", maxResults: 3 })).toEqual([
			{ key: "posts/a.md", metadata: { title: "A" } },
		]);
		expect(await requests[2]!.json()).toMatchObject({
			query: "hello",
			ai_search_options: { retrieval: { max_num_results: 3, metadata_only: true } },
		});
		expect(provider.requests).toBe(requests.length);
	});

	it("reports an unreachable API as a failed call", async () => {
		const provider = new RestAiSearch(credentials, "emdash", async () => {
			throw new TypeError("fetch failed");
		});

		await expect(provider.stats()).rejects.toMatchObject({
			name: "ProviderError",
			reason: "failed",
		});
	});

	it("treats a rejected token as unauthorized, even when Cloudflare answers HTTP 400", async () => {
		const respond = (status: number, code: number) => async () =>
			Response.json(
				{ success: false, errors: [{ code, message: "Authentication failed" }] },
				{ status },
			);

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

	it("keeps diagnostic token checks within the remaining request budget", async () => {
		const { provider, requests } = restWith(() => failure(401));
		provider.limitRequests(1);

		expect(await provider.tokenRejected()).toBe(false);
		await expect(provider.stats()).rejects.toMatchObject({ reason: "rate-limited" });
		expect(requests).toHaveLength(1);
	});
});
