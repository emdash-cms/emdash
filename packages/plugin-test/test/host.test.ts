import { afterEach, describe, expect, it } from "vitest";

import { createPluginTestHost, type PluginTestHost } from "../src/index.js";

let host: PluginTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

describe("plugin test host", () => {
	it("loads the built plugin through Worker Loader and persists host state", async () => {
		host = await createPluginTestHost();

		await expect(host.invokeRoute("hello")).resolves.toEqual({
			pluginId: "plugin-test-fixture",
		});
		await expect(host.kv.get("last-route")).resolves.toBe("hello");

		await host.invokeHook("content:afterSave", {
			collection: "posts",
			content: { id: "post-1" },
		});
		await expect(host.storage("events").get("post-1")).resolves.toEqual({
			type: "saved",
			collection: "posts",
		});
	});

	it("uses a migrated D1 database for content bridge calls", async () => {
		host = await createPluginTestHost();
		await host.createCollection({
			slug: "posts",
			label: "Posts",
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});
		await host.seedContent("posts", [{ title: "First" }, { title: "Second" }]);

		await expect(host.invokeRoute("content-count")).resolves.toEqual({ count: 2 });
	});
});
