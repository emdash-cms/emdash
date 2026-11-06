import { createSandboxRouteError } from "emdash";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MiniflareDevRunner } from "../src/sandbox/dev-runner.js";

const CONTENT_WRITE_PLUGIN = `
export default {
	hooks: {},
	routes: {
		"write": {
			handler: async (_routeCtx, ctx) => ctx.content.create("posts", { slug: "blocked" })
		}
	}
};
`;

const CONTENT_PUBLISH_PLUGIN = `
export default {
	hooks: {},
	routes: {
		"publish": {
			handler: async (_routeCtx, ctx) =>
				ctx.content.publish("posts", "post-1", { _rev: "revision-1" })
		}
	}
};
`;

describe("Miniflare sandbox route errors", () => {
	let runner: MiniflareDevRunner | null = null;

	afterEach(async () => {
		await runner?.terminateAll();
	});

	it("preserves a content-write fence through the development sandbox", async () => {
		runner = new MiniflareDevRunner({
			db: null as never,
			beforeContentWrite: async () => {
				throw createSandboxRouteError("MEDIA_USAGE_ACTIVATION_IN_PROGRESS");
			},
		});
		const plugin = await runner.load(
			{
				id: "content-writer",
				version: "1.0.0",
				capabilities: ["write:content"],
				allowedHosts: [],
				storage: {},
				hooks: [],
				routes: [],
				admin: {},
			},
			CONTENT_WRITE_PLUGIN,
		);

		await expect(
			plugin.invokeRoute(
				"write",
				{},
				{
					url: "https://example.com/_emdash/api/plugins/content-writer/write",
					method: "POST",
					headers: {},
					meta: { ip: null, userAgent: null, referer: null, geo: null },
				},
			),
		).rejects.toMatchObject({
			code: "MEDIA_USAGE_ACTIVATION_IN_PROGRESS",
			message: "Media usage activation is in progress",
			status: 503,
		});
	});

	it("routes publication actions through the development sandbox", async () => {
		const contentActions = {
			begin: vi.fn(),
			flush: vi.fn().mockResolvedValue(undefined),
			publish: vi.fn().mockResolvedValue({
				item: { id: "post-1", status: "published" },
				_rev: "revision-2",
			}),
		};
		runner = new MiniflareDevRunner({
			db: null as never,
			contentActions: contentActions as never,
		});
		const plugin = await runner.load(
			{
				id: "content-publisher",
				version: "1.0.0",
				capabilities: ["content:publish"],
				allowedHosts: [],
				storage: {},
				hooks: [],
				routes: [],
				admin: {},
			},
			CONTENT_PUBLISH_PLUGIN,
		);
		const invalidateContentCache = vi.fn().mockResolvedValue(undefined);

		await expect(
			plugin.invokeRoute(
				"publish",
				{},
				{
					url: "https://example.com/_emdash/api/plugins/content-publisher/publish",
					method: "POST",
					headers: {},
					meta: { ip: null, userAgent: null, referer: null, geo: null },
				},
				{ invalidateContentCache },
			),
		).resolves.toMatchObject({ item: { id: "post-1", status: "published" } });

		expect(contentActions.begin).toHaveBeenCalledWith(
			"content-publisher",
			expect.any(String),
			invalidateContentCache,
		);
		const invocationId = contentActions.begin.mock.calls[0]?.[1];
		expect(contentActions.publish).toHaveBeenCalledWith(
			"content-publisher",
			"posts",
			"post-1",
			{ _rev: "revision-1" },
			invocationId,
		);
		await vi.waitFor(() => {
			expect(contentActions.flush).toHaveBeenCalledWith("content-publisher", invocationId, true);
		});
	});
});
