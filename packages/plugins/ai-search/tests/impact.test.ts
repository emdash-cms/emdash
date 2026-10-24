import { describe, expect, it } from "vitest";

import { indexImpact } from "../src/impact.js";
import { config } from "./fakes.js";

const PAGES = { enabled: true, fields: ["title"], weight: 2 };

describe("indexImpact", () => {
	it("adds a newly enabled source without touching the others", () => {
		const saved = config();
		const next = { ...saved, sources: { ...saved.sources, pages: PAGES } };
		expect(indexImpact(saved, next)).toEqual([{ source: "pages", change: "add" }]);
	});

	it("removes a disabled source", () => {
		const saved = config({ sources: { ...config().sources, pages: PAGES } });
		const next = { ...saved, sources: { ...saved.sources, pages: { ...PAGES, enabled: false } } };
		expect(indexImpact(saved, next)).toEqual([{ source: "pages", change: "remove" }]);
	});

	it("re-indexes a source whose fields or weight change", () => {
		const saved = config();
		const posts = saved.sources.posts!;
		const next = { ...saved, sources: { ...saved.sources, posts: { ...posts, weight: 1 } } };
		expect(indexImpact(saved, next)).toEqual([{ source: "posts", change: "reindex" }]);
	});

	it("re-indexes only the collection whose related names change", () => {
		const saved = config({ sources: { ...config().sources, pages: PAGES } });
		const posts = saved.sources.posts!;
		const next = {
			...saved,
			sources: { ...saved.sources, posts: { ...posts, includeAuthorNames: false } },
		};
		expect(indexImpact(saved, next)).toEqual([{ source: "posts", change: "reindex" }]);
	});

	it("adds every enabled source on first setup", () => {
		expect(indexImpact(null, config())).toEqual([
			{ source: "posts", change: "add" },
			{ source: "_authors", change: "add" },
		]);
	});
});
