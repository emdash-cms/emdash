import type { CollectionSchemaInfo } from "emdash";
import { describe, expect, it } from "vitest";

import { resultLabels } from "../src/config.js";
import {
	parseSearchRequest,
	type SearchInput,
	searchIndex,
	searchResponse,
} from "../src/search.js";
import { config } from "./fakes.js";

type Chunk = AiSearchSearchResponse["chunks"][number];

function chunk(key: string, score: number, metadata: Record<string, unknown> = {}): Chunk {
	return {
		id: `${key}-${score}`,
		type: "text",
		score,
		text: "",
		item: {
			key,
			metadata: {
				source: "posts",
				locale: "en",
				title: key,
				url: `/${key}`,
				excerpt: "",
				hash: "hash",
				...metadata,
			},
		},
	};
}

function instanceReturning(chunks: Chunk[]) {
	const requests: AiSearchSearchRequest[] = [];
	const instance = {
		search: async (request: AiSearchSearchRequest) => {
			requests.push(request);
			return { search_query: "", chunks };
		},
	} as unknown as AiSearchInstance;
	return { instance, requests };
}

const all = () => true;

const input = (overrides: Partial<SearchInput> = {}): SearchInput => ({
	query: "gardens",
	limit: 10,
	...overrides,
});

describe("searchIndex", () => {
	it("returns one result per document in AI Search's ranking, boosted by priority", async () => {
		const { instance, requests } = instanceReturning([
			chunk("a", 0.9),
			chunk("b", 0.7),
			chunk("a", 0.5),
		]);

		const hits = await searchIndex(instance, input(), all);

		expect(hits.map((hit) => hit.title)).toEqual(["a", "b"]);
		expect(requests[0]?.ai_search_options?.retrieval?.boost_by).toEqual([
			{ field: "priority", direction: "desc" },
		]);
	});

	it("skips chunks from items without display metadata", async () => {
		const { instance } = instanceReturning([
			chunk("a", 0.9, { title: undefined }),
			chunk("b", 0.5),
		]);

		const hits = await searchIndex(instance, input(), all);

		expect(hits.map((hit) => hit.title)).toEqual(["b"]);
	});

	it("filters by locale in AI Search and caps the result count", async () => {
		const { instance, requests } = instanceReturning([chunk("a", 0.9), chunk("b", 0.8)]);

		const hits = await searchIndex(instance, input({ locale: "pt", limit: 1 }), all);

		expect(requests[0]?.ai_search_options?.retrieval?.filters).toEqual({ locale: "pt" });
		expect(hits).toHaveLength(1);
	});
});

describe("parseSearchRequest", () => {
	it("reads the snippet's request: last user message, result cap, and locale", () => {
		expect(
			parseSearchRequest({
				messages: [
					{ role: "user", content: "old" },
					{ role: "user", content: " gardens " },
				],
				stream: false,
				locale: "pt",
				ai_search_options: { retrieval: { metadata_only: true, max_num_results: 500 } },
			}),
		).toEqual({ query: "gardens", locale: "pt", limit: 50 });
	});
});

describe("searchResponse", () => {
	const collections = [
		{ slug: "posts", label: "Articles", urlPattern: "/blog/{slug}", routable: true },
	] as CollectionSchemaInfo[];

	const request = { messages: [{ role: "user", content: "gardens" }] };

	async function body(response: Awaited<ReturnType<typeof searchResponse>>) {
		expect(response.body?.kind).toBe("text");
		return JSON.parse(response.body?.kind === "text" ? response.body.value : "null");
	}

	it("groups results by the labels saved with the config, without disabled sources", async () => {
		const { instance } = instanceReturning([
			chunk("a", 0.9),
			chunk("b", 0.8, { source: "pages" }),
			chunk("c", 0.7, { source: "_authors" }),
		]);

		const response = await searchResponse(
			{ config: config({ labels: resultLabels(collections) }), instance },
			request,
		);

		const { chunks } = (await body(response)).result;
		expect(
			chunks.map((c: { item: { key: string; metadata: { group: string } } }) => [
				c.item.key,
				c.item.metadata.group,
			]),
		).toEqual([
			["/a", "Articles"],
			["/c", "Authors"],
		]);
	});

	it("sends titles and excerpts as text for the search box, which reads them as HTML", async () => {
		const { instance } = instanceReturning([
			chunk("a", 0.9, { title: "<img src=x> & co", excerpt: "Use <b>bold</b>" }),
		]);

		const response = await searchResponse({ config: config(), instance }, request);

		const [result] = (await body(response)).result.chunks;
		const { title, description } = result.item.metadata;
		const textOf = (html: string) =>
			html.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
		expect(title).not.toContain("<");
		expect(textOf(title)).toBe("<img src=x> & co");
		expect(textOf(description)).toBe("Use <b>bold</b>");
	});
});
