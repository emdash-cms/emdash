import { describe, expect, it } from "vitest";

import type { OptionsRepository } from "../../../src/database/repositories/options.js";
import { createKVAccess } from "../../../src/plugins/context.js";

function fakeOptionsRepo(rows: Record<string, unknown>) {
	const prefixQueries: string[] = [];
	const repo = {
		async get(name: string) {
			return rows[name] ?? null;
		},
		async getByPrefix(prefix: string) {
			prefixQueries.push(prefix);
			return new Map(Object.entries(rows).filter(([name]) => name.startsWith(prefix)));
		},
	};
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- only the two read methods are exercised
	return { repo: repo as unknown as OptionsRepository, prefixQueries };
}

describe("createKVAccess list", () => {
	it("lists a settings prefix with one scan of the options table", async () => {
		const { repo, prefixQueries } = fakeOptionsRepo({
			"plugin:seo:settings:title": "Site",
			"plugin:seo:settings:description": "About the site",
			"plugin:seo:cache:etag": "abc",
		});
		const kv = createKVAccess(repo, "seo");

		const entries = await kv.list("settings:");

		expect(entries.map((entry) => entry.key).toSorted()).toEqual([
			"settings:description",
			"settings:title",
		]);
		expect(prefixQueries).toEqual(["plugin:seo:settings:"]);
	});

	it("lists a settings sub-prefix with one scan of the options table", async () => {
		const { repo, prefixQueries } = fakeOptionsRepo({
			"plugin:seo:settings:social:x": "@site",
			"plugin:seo:settings:title": "Site",
		});
		const kv = createKVAccess(repo, "seo");

		const entries = await kv.list("settings:social:");

		expect(entries).toEqual([{ key: "settings:social:x", value: "@site" }]);
		expect(prefixQueries).toEqual(["plugin:seo:settings:social:"]);
	});

	it("still lists every key, settings included, for an empty prefix", async () => {
		const { repo, prefixQueries } = fakeOptionsRepo({
			"plugin:seo:settings:title": "Site",
			"plugin:seo:cache:etag": "abc",
		});
		const kv = createKVAccess(repo, "seo");

		const entries = await kv.list();

		expect(entries.map((entry) => entry.key).toSorted()).toEqual(["cache:etag", "settings:title"]);
		expect(prefixQueries).toEqual(["plugin:seo:", "plugin:seo:settings:"]);
	});
});
