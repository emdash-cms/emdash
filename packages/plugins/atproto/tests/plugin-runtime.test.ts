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
				query: vi.fn(async () => ({ items: [] })),
				count: vi.fn(async () => 0),
			},
		},
		media: {
			readBytes: vi.fn(),
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

function pdsResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status });
}

const uploadedBlob = {
	$type: "blob",
	ref: { $link: "bafy-uploaded-image" },
	mimeType: "image/png",
	size: 4,
};

function configuredCtx() {
	const ctx = createCtx({
		"settings:siteUrl": "https://example.com",
		"settings:siteName": "Example",
		"state:publicationUri": "at://did:example/site.standard.publication/self",
		"settings:handle": "writer.example.com",
		"settings:appPassword": "app-password",
		"settings:pdsHost": "bsky.social",
		"state:accessJwt": "valid-access-jwt",
		"state:did": "did:example",
	});
	ctx.media.readBytes.mockResolvedValue({
		bytes: new Uint8Array([137, 80, 78, 71]),
		mimeType: "image/png",
	});
	ctx.http.fetch.mockImplementation(async (input: string, init?: RequestInit) => {
		if (input.endsWith("/com.atproto.repo.uploadBlob")) return pdsResponse({ blob: uploadedBlob });
		if (input.endsWith("/com.atproto.repo.createRecord")) {
			const body = JSON.parse(init?.body as string);
			return pdsResponse({
				uri: `at://did:example/${body.collection}/record`,
				cid: `cid-${body.collection}`,
			});
		}
		if (input.endsWith("/com.atproto.repo.putRecord"))
			return pdsResponse({ uri: "at://did:example/site.standard.document/record", cid: "cid-put" });
		throw new Error(`unexpected HTTP request: ${input}`);
	});
	return ctx;
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

	it("uses featured_image media for the standard.site document and Bluesky thumbnail", async () => {
		const { default: plugin } = await import("../src/plugin.js");
		const ctx = configuredCtx();
		const handler = (plugin as any).hooks["content:afterPublish"].handler;

		await handler(
			{
				collection: "posts",
				content: {
					id: "post-1",
					status: "published",
					data: {
						title: "A post with an image",
						featured_image: { provider: "local", id: "media-1", meta: { storageKey: "key.png" } },
					},
				},
			},
			ctx,
		);

		expect(ctx.media.readBytes).toHaveBeenCalledWith("media-1", { maxBytes: 1_000_000 });
		expect(
			ctx.http.fetch.mock.calls.some(([url]) => String(url).startsWith("https://example.com")),
		).toBe(false);
		const pdsBodies = ctx.http.fetch.mock.calls
			.filter(([url]) => /com.atproto.repo.(createRecord|putRecord)$/.test(String(url)))
			.map(([, init]) => JSON.parse((init as RequestInit).body as string));
		const document = pdsBodies.find((body) => body.collection === "site.standard.document");
		const bsky = pdsBodies.find((body) => body.collection === "app.bsky.feed.post");
		expect(document.record.coverImage).toEqual(uploadedBlob);
		expect(bsky.record.embed.external.thumb).toEqual(uploadedBlob);
	});

	it.each([
		[
			"cannot be read",
			vi.fn(async () => {
				throw new Error("media unavailable");
			}),
			"media storage",
		],
		[
			"is too large",
			vi.fn(async () => {
				throw new RangeError("Media exceeds the requested 1000000-byte limit");
			}),
			"smaller",
		],
		[
			"missing capability",
			vi.fn(async () => {
				throw new Error("Missing capability: media:bytes:read");
			}),
			"Approve",
		],
		[
			"missing or not ready",
			vi.fn(async () => {
				throw new Error("Media item is not ready or does not exist");
			}),
			"Select the image again",
		],
	])(
		"publishes without an image when the featured image %s and reports a warning",
		async (_reason, readBytes, warningText) => {
			const { default: plugin } = await import("../src/plugin.js");
			const ctx = configuredCtx();
			ctx.media.readBytes.mockImplementation(readBytes);
			const handler = (plugin as any).hooks["content:afterPublish"].handler;

			await handler(
				{
					collection: "posts",
					content: {
						id: "post-1",
						status: "published",
						data: {
							title: "A post",
							featured_image: { provider: "local", id: "media-1", meta: { storageKey: "key.png" } },
						},
					},
				},
				ctx,
			);

			const record = ctx.storage.records.put.mock.calls.at(-1)?.[1];
			expect(record.status).toBe("synced");
			expect(record.imageWarning).toContain(warningText);
			if (_reason !== "is too large") expect(record.imageWarning).not.toContain("1,000,000");
			const admin = (plugin as any).routes.admin.handler;
			ctx.storage.records.query.mockResolvedValue({
				items: [{ id: "posts:post-1", data: record }],
			});
			const page = await admin({ input: { type: "page_load", page: "/status" } }, ctx);
			expect(JSON.stringify(page.blocks)).toContain(record.imageWarning);
		},
	);

	it("clears an old image warning after a successful featured image read", async () => {
		const { default: plugin } = await import("../src/plugin.js");
		const ctx = configuredCtx();
		ctx.storage.records.get.mockResolvedValue({
			collection: "posts",
			contentId: "post-1",
			atUri: "at://did:example/site.standard.document/record",
			atCid: "old-cid",
			bskyPostUri: "at://did:example/app.bsky.feed.post/post",
			bskyPostCid: "old-bsky-cid",
			status: "synced",
			imageWarning: "previously failed",
			publishedAt: "2025-01-01T00:00:00.000Z",
		});
		const handler = (plugin as any).hooks["content:afterPublish"].handler;

		await handler(
			{
				collection: "posts",
				content: {
					id: "post-1",
					status: "published",
					data: {
						title: "Updated post",
						featured_image: { provider: "local", id: "media-1", meta: { storageKey: "key.png" } },
					},
				},
			},
			ctx,
		);

		const record = ctx.storage.records.put.mock.calls.at(-1)?.[1];
		expect(record.status).toBe("synced");
		expect(record).not.toHaveProperty("imageWarning");
		const documentUpdate = ctx.http.fetch.mock.calls
			.filter(([url]) => String(url).endsWith("/com.atproto.repo.putRecord"))
			.map(([, init]) => JSON.parse((init as RequestInit).body as string))
			.find((body) => body.collection === "site.standard.document");
		expect(documentUpdate.record.coverImage).toEqual(uploadedBlob);
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
});
