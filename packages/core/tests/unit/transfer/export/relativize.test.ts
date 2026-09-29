import { describe, expect, it } from "vitest";

import type { EntryRecord } from "../../../../src/transfer/format/kinds.js";
import {
	buildMediaKeyIndex,
	rewriteMediaRefs,
} from "../../../../src/transfer/format/media-refs.js";

const HERO_ID = "01HZ0000000000000000000170";
const HERO_KEY = "01HZAAAAAAAAAAAAAAAAAAAAAA.jpg";
const keys = buildMediaKeyIndex([{ id: HERO_ID, storageKey: HERO_KEY }]);

function entry(text: string): EntryRecord {
	return {
		kind: "entry",
		id: "01HZ0000000000000000000210",
		collection: "posts",
		locale: "en",
		fields: { body: text },
	};
}

describe("media URL relativization on export", () => {
	it("drops scheme and host from absolute URLs to a known key", () => {
		const result = rewriteMediaRefs(
			entry(
				`<img src="https://origin.example:8443/_emdash/api/media/file/${HERO_KEY}"> <a href="//cdn.example/_emdash/api/media/file/${HERO_KEY}">`,
			),
			{ mode: "export", keys, relativize: true },
		);
		expect(result.value.fields.body).toBe(
			`<img src="/_emdash/api/media/file/emdash-media:${HERO_ID}"> <a href="/_emdash/api/media/file/emdash-media:${HERO_ID}">`,
		);
		expect(result.relativized).toBe(2);
		expect(result.errors).toEqual([]);
	});

	it("does not count relative URLs and leaves unknown keys absolute", () => {
		const result = rewriteMediaRefs(
			entry(
				`/_emdash/api/media/file/${HERO_KEY} https://elsewhere.example/_emdash/api/media/file/unknown.jpg`,
			),
			{ mode: "export", keys, relativize: true },
		);
		expect(result.value.fields.body).toBe(
			`/_emdash/api/media/file/emdash-media:${HERO_ID} https://elsewhere.example/_emdash/api/media/file/unknown.jpg`,
		);
		expect(result.relativized).toBe(0);
		expect(result.warnings.map((warning) => warning.code)).toEqual(["unknown_storage_key"]);
	});

	it("keeps the origin without the relativize option", () => {
		const result = rewriteMediaRefs(
			entry(`https://origin.example/_emdash/api/media/file/${HERO_KEY}`),
			{ mode: "export", keys },
		);
		expect(result.value.fields.body).toBe(
			`https://origin.example/_emdash/api/media/file/emdash-media:${HERO_ID}`,
		);
		expect(result.relativized).toBe(0);
	});
});
