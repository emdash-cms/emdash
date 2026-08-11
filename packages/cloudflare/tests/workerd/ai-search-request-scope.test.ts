import { withEnv } from "cloudflare:workers";
import type { PluginContext } from "emdash";
import { describe, expect, it } from "vitest";

import { createPlugin } from "../../src/plugins/ai-search.js";

function makeContext(): PluginContext {
	const store = new Map<string, unknown>();
	return {
		kv: {
			get: async <T>(key: string) => (store.get(key) as T | undefined) ?? null,
			set: async (key: string, value: unknown) => void store.set(key, value),
			delete: async (key: string) => void store.delete(key),
			list: async (prefix: string) =>
				[...store.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
		},
		site: { name: "Test", url: "http://localhost", locale: "en" },
	} as unknown as PluginContext;
}

describe("ai-search request bindings", () => {
	it("resolves the current binding for each request with one plugin instance", async () => {
		const uploadedByRequest: string[][] = [[], []];
		const bindingFor = (request: number) => {
			const instance = {
				info: async () => ({ id: "emdash-content" }),
				update: async () => {},
				search: async () => ({ search_query: "", chunks: [] }),
				items: {
					upload: async (key: string) => {
						uploadedByRequest[request]!.push(key);
						return { id: `request-${request}` };
					},
					delete: async () => {},
				},
			};
			return {
				AI_SEARCH: {
					get: () => instance,
					create: async () => instance,
				},
			};
		};
		const plugin = createPlugin();
		const context = makeContext();

		for (const request of [0, 1]) {
			const id = `request-${request}`;
			await withEnv(bindingFor(request), () => {
				return plugin.hooks["content:afterSave"]!.handler(
					{
						content: {
							id,
							slug: id,
							status: "published",
							locale: "en",
							data: { title: id, content: `${id} body` },
						},
						collection: "posts",
						isNew: true,
					},
					context,
				);
			});
		}

		expect(uploadedByRequest).toEqual([["posts/request-0.md"], ["posts/request-1.md"]]);
	});
});
