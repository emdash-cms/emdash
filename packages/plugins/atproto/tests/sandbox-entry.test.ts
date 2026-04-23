import { describe, it, expect, vi } from "vitest";

vi.mock("emdash", () => ({
	definePlugin: (definition: unknown) => definition,
}));

function createCtx() {
	return {
		kv: {
			get: vi.fn(async () => undefined),
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

describe("sandbox hooks", () => {
	it("does not create syndication records from afterSave when published content has not been synced", async () => {
		const { default: plugin } = await import("../src/sandbox-entry.js");
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

	it("does not syndicate pages by default", async () => {
		const { default: plugin } = await import("../src/sandbox-entry.js");
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
});
