import { createSandboxRouteError } from "emdash";
import { afterEach, describe, expect, it } from "vitest";

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
});
