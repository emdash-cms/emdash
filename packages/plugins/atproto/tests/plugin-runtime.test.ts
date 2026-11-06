import { describe, it, expect, vi } from "vitest";

vi.mock("emdash", () => ({
	definePlugin: (definition: unknown) => definition,
}));

function createCtx(kvValues: Record<string, unknown> = {}) {
	return {
		kv: {
			get: vi.fn(async (key: string) => kvValues[key]),
			set: vi.fn(async () => undefined),
		},
		storage: {
			records: {
				get: vi.fn(async () => null),
				put: vi.fn(async () => undefined),
			},
		},
		http: {
			fetch: vi.fn(),
		},
		log: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
	};
}

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function setupExistingSync({
	document,
	bskyFailure = false,
}: {
	document: Record<string, unknown> | null;
	bskyFailure?: boolean;
}) {
	const ctx = createCtx({
		"settings:siteUrl": "https://example.com",
		"state:publicationUri": "at://did:example/site.standard.publication/self",
		"settings:pdsHost": "bsky.social",
		"settings:handle": "writer.example.com",
		"settings:appPassword": "app-password",
		"state:accessJwt": "access-jwt",
		"state:did": "did:example",
	});
	ctx.storage.records.get.mockResolvedValue({
		collection: "posts",
		contentId: "post-1",
		atUri: "at://did:example/site.standard.document/doc-1",
		atCid: "old-doc-cid",
		bskyPostUri: "at://did:example/app.bsky.feed.post/post-1",
		bskyPostCid: "old-post-cid",
		publishedAt: "2024-01-01T00:00:00.000Z",
		status: "synced",
	});

	const pds = {
		document,
		documentAtPostWrite: undefined as Record<string, unknown> | null | undefined,
		bskyPosts: [] as Record<string, unknown>[],
		documentWrites: 0,
	};
	ctx.http.fetch.mockImplementation(async (input: string, init?: RequestInit) => {
		const url = String(input);
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		if (url.endsWith("com.atproto.repo.putRecord")) {
			if (body.collection === "app.bsky.feed.post") {
				pds.documentAtPostWrite = pds.document;
				pds.bskyPosts.push(body.record as Record<string, unknown>);
				if (bskyFailure) return jsonResponse({ error: "failed" }, 500);
				return jsonResponse({
					uri: "at://did:example/app.bsky.feed.post/post-1",
					cid: "fresh-post-cid",
				});
			}
			pds.document = body.record as Record<string, unknown>;
			pds.documentWrites++;
			return jsonResponse({
				uri: "at://did:example/site.standard.document/doc-1",
				cid: pds.documentWrites === 1 ? "initial-doc-cid" : "final-doc-cid",
			});
		}
		throw new Error(`Unexpected PDS request: ${url}`);
	});

	return { ctx, pds };
}

describe("sandbox hooks", () => {
	it("does not create syndication records from afterSave when published content has not been synced", async () => {
		const { default: plugin } = await import("../src/plugin.js");
		const ctx = createCtx();
		const handler = (plugin as any).hooks["content:afterSave"].handler;

		await handler(
			{
				collection: "posts",
				isNew: false,
				content: {
					id: "post-1",
					status: "published",
					title: "A published edit",
				},
			},
			ctx,
		);

		expect(ctx.storage.records.get).toHaveBeenCalledWith("posts:post-1");
		expect(ctx.storage.records.put).not.toHaveBeenCalled();
		expect(ctx.http.fetch).not.toHaveBeenCalled();
		expect(ctx.kv.get).not.toHaveBeenCalledWith("settings:siteUrl");
	});

	it.each([
		{ draftRevisionId: "rev-draft", syncs: false },
		{ draftRevisionId: null, syncs: true },
	])(
		"syncs a save to a synced, published post only without a pending draft (draft $draftRevisionId)",
		async ({ draftRevisionId, syncs }) => {
			const { default: plugin } = await import("../src/plugin.js");
			const ctx = createCtx({
				"settings:siteUrl": "https://example.com",
				"state:publicationUri": "at://did:example/site.standard.publication/self",
				"settings:handle": "writer.example.com",
				"settings:appPassword": "app-password",
				"state:accessJwt": "access-jwt",
				"state:did": "did:example",
			});
			ctx.storage.records.get.mockResolvedValue({
				collection: "posts",
				contentId: "post-1",
				atUri: "at://did:example/site.standard.document/abc",
				atCid: "bafy",
				status: "synced",
			});
			const handler = (plugin as any).hooks["content:afterSave"].handler;

			await handler(
				{
					collection: "posts",
					isNew: false,
					content: { id: "post-1", status: "published", draftRevisionId, title: "Edited title" },
				},
				ctx,
			);

			expect(ctx.http.fetch.mock.calls.length > 0).toBe(syncs);
		},
	);

	it("does not syndicate pages by default", async () => {
		const { default: plugin } = await import("../src/plugin.js");
		const ctx = createCtx();
		const handler = (plugin as any).hooks["content:afterPublish"].handler;

		await handler(
			{
				collection: "pages",
				content: {
					id: "page-1",
					status: "published",
					title: "About",
				},
			},
			ctx,
		);

		expect(ctx.kv.get).toHaveBeenCalledWith("settings:collections");
		expect(ctx.storage.records.get).not.toHaveBeenCalled();
		expect(ctx.storage.records.put).not.toHaveBeenCalled();
		expect(ctx.http.fetch).not.toHaveBeenCalled();
	});

	it("does not expose standard.site metadata for pages by default", async () => {
		const { default: plugin } = await import("../src/plugin.js");
		const ctx = createCtx();
		ctx.storage.records.get.mockResolvedValueOnce({
			atUri: "at://did:example/site.standard.document/abc",
			status: "synced",
		});

		const result = await (plugin as any).hooks["page:metadata"](
			{
				page: {
					content: {
						collection: "pages",
						id: "page-1",
					},
				},
			},
			ctx,
		);

		expect(result).toBeNull();
		expect(ctx.kv.get).toHaveBeenCalledWith("settings:collections");
		expect(ctx.storage.records.get).not.toHaveBeenCalled();
	});

	describe("existing syndication records", () => {
		it.each([
			["missing", null],
			["stale", { $type: "site.standard.document", title: "Old title" }],
		])("writes the document before updating the Bluesky post (%s)", async (_case, document) => {
			const { default: plugin } = await import("../src/plugin.js");
			const { ctx, pds } = setupExistingSync({ document });
			const handler = (plugin as any).hooks["content:afterSave"].handler;

			await handler(
				{
					collection: "posts",
					isNew: false,
					content: { id: "post-1", status: "published", title: "Updated title" },
				},
				ctx,
			);

			expect(pds.bskyPosts).toHaveLength(1);
			expect(pds.documentAtPostWrite).toMatchObject({ title: "Updated title" });
			expect(pds.document).toMatchObject({
				title: "Updated title",
				bskyPostRef: { uri: "at://did:example/app.bsky.feed.post/post-1", cid: "fresh-post-cid" },
			});
			expect(ctx.storage.records.put).toHaveBeenLastCalledWith(
				"posts:post-1",
				expect.objectContaining({
					atCid: "final-doc-cid",
					bskyPostCid: "fresh-post-cid",
					status: "synced",
				}),
			);
		});

		it("does not update Bluesky when the document write fails", async () => {
			const { default: plugin } = await import("../src/plugin.js");
			const { ctx } = setupExistingSync({ document: null });
			ctx.http.fetch.mockImplementation(async (input: string, init?: RequestInit) => {
				if (input.endsWith("com.atproto.repo.putRecord")) {
					expect(JSON.parse(String(init?.body)).collection).toBe("site.standard.document");
					return jsonResponse({ error: "failed" }, 500);
				}
				throw new Error(`Unexpected PDS request: ${input}`);
			});
			await (plugin as any).hooks["content:afterSave"].handler(
				{
					collection: "posts",
					isNew: false,
					content: { id: "post-1", status: "published", title: "Updated title" },
				},
				ctx,
			);

			expect(ctx.http.fetch).toHaveBeenCalledTimes(1);
			expect(ctx.storage.records.put).toHaveBeenLastCalledWith(
				"posts:post-1",
				expect.objectContaining({ status: "error", atCid: "old-doc-cid" }),
			);
			expect(ctx.log.error).toHaveBeenCalled();
		});

		it("records an error when saving the refreshed post reference fails", async () => {
			const { default: plugin } = await import("../src/plugin.js");
			const { ctx, pds } = setupExistingSync({ document: null });
			const fetch = ctx.http.fetch.getMockImplementation()!;
			ctx.http.fetch.mockImplementation(async (input: string, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body));
				if (body.collection === "site.standard.document" && pds.documentWrites === 1) {
					return jsonResponse({ error: "failed" }, 500);
				}
				return fetch(input, init);
			});
			await (plugin as any).hooks["content:afterSave"].handler(
				{
					collection: "posts",
					isNew: false,
					content: { id: "post-1", status: "published", title: "Updated title" },
				},
				ctx,
			);

			expect(pds.bskyPosts).toHaveLength(1);
			expect(pds.document).toMatchObject({ bskyPostRef: { cid: "old-post-cid" } });
			expect(ctx.storage.records.put).toHaveBeenLastCalledWith(
				"posts:post-1",
				expect.objectContaining({ status: "error", retryCount: 1 }),
			);
		});

		it("retains the old post reference when the Bluesky update fails", async () => {
			const { default: plugin } = await import("../src/plugin.js");
			const { ctx, pds } = setupExistingSync({
				document: { $type: "site.standard.document", title: "Updated title" },
				bskyFailure: true,
			});
			await (plugin as any).hooks["content:afterSave"].handler(
				{
					collection: "posts",
					isNew: false,
					content: { id: "post-1", status: "published", title: "Updated title" },
				},
				ctx,
			);

			expect(pds.document).toMatchObject({
				title: "Updated title",
				bskyPostRef: { uri: "at://did:example/app.bsky.feed.post/post-1", cid: "old-post-cid" },
			});
			expect(ctx.storage.records.put).toHaveBeenLastCalledWith(
				"posts:post-1",
				expect.objectContaining({
					status: "synced",
					atCid: "initial-doc-cid",
					bskyPostCid: "old-post-cid",
				}),
			);
		});

		it("writes only the document when crossposting is disabled", async () => {
			const { default: plugin } = await import("../src/plugin.js");
			const { ctx, pds } = setupExistingSync({ document: null });
			const getKv = ctx.kv.get.getMockImplementation()!;
			ctx.kv.get.mockImplementation(async (key: string) =>
				key === "settings:enableBskyCrosspost" ? false : getKv(key),
			);
			await (plugin as any).hooks["content:afterSave"].handler(
				{
					collection: "posts",
					isNew: false,
					content: { id: "post-1", status: "published", title: "Updated title" },
				},
				ctx,
			);

			expect(ctx.http.fetch).toHaveBeenCalledTimes(1);
			expect(pds.bskyPosts).toHaveLength(0);
			expect(pds.document).toMatchObject({
				title: "Updated title",
				bskyPostRef: { cid: "old-post-cid" },
			});
		});
	});
});
