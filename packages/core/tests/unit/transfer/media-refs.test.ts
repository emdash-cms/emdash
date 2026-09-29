import { describe, expect, it } from "vitest";

import type { EntryRecord, SitePackageRecord } from "../../../src/transfer/format/kinds.js";
import {
	buildMediaKeyIndex,
	mediaPlaceholder,
	parseMediaPlaceholder,
	relativizePlaceholderUrls,
	rewriteMediaRefs,
	scanForKeys,
	scannableKeys,
} from "../../../src/transfer/format/media-refs.js";

const HERO_ID = "01HZ0000000000000000000170";
const INLINE_ID = "01HZ0000000000000000000171";
const HERO_KEY = "01HZAAAAAAAAAAAAAAAAAAAAAA.jpg";
const INLINE_KEY = "01HZBBBBBBBBBBBBBBBBBBBBBB.png";

const keys = buildMediaKeyIndex([
	{ id: HERO_ID, storageKey: HERO_KEY },
	{ id: INLINE_ID, storageKey: INLINE_KEY },
]);
const targetKeys = new Map([
	[HERO_ID, "01TARGETHERO00000000000000.jpg"],
	[INLINE_ID, "01TARGETINLINE000000000000.png"],
]);

function stringValue(value: unknown): string {
	if (typeof value !== "string") throw new Error("expected a string");
	return value;
}

function entry(fields: EntryRecord["fields"], extra: Partial<EntryRecord> = {}): EntryRecord {
	return {
		kind: "entry",
		id: "01HZ0000000000000000000210",
		collection: "posts",
		locale: "en",
		fields,
		...extra,
	};
}

function exportRecord<T extends SitePackageRecord>(record: T) {
	return rewriteMediaRefs(record, { mode: "export", keys });
}

describe("placeholders", () => {
	it("formats and parses placeholders", () => {
		expect(mediaPlaceholder(HERO_ID)).toBe(`emdash-media:${HERO_ID}`);
		expect(parseMediaPlaceholder(`emdash-media:${HERO_ID}`)).toBe(HERO_ID);
		expect(parseMediaPlaceholder(`emdash-media:${HERO_ID}.jpg`)).toBeNull();
		expect(parseMediaPlaceholder("emdash-media:")).toBeNull();
		expect(() => mediaPlaceholder("has space")).toThrow(TypeError);
	});
});

describe("buildMediaKeyIndex", () => {
	it("maps a shared key to the smallest media id", () => {
		const index = buildMediaKeyIndex([
			{ id: "01B", storageKey: "shared.jpg" },
			{ id: "01A", storageKey: "shared.jpg" },
		]);
		expect(index.keyToMediaId.get("shared.jpg")).toBe("01A");
	});
});

describe("rewriteMediaRefs export mode", () => {
	it("rewrites image field values stored as JSON text via meta.storageKey", () => {
		const value = JSON.stringify({
			id: HERO_ID,
			provider: "local",
			meta: { storageKey: HERO_KEY },
			alt: "Hero",
		});
		const result = exportRecord(entry({ featured_image: value }));
		expect(result.changed).toBe(true);
		expect(JSON.parse(stringValue(result.value.fields.featured_image))).toEqual({
			id: HERO_ID,
			provider: "local",
			meta: { storageKey: `emdash-media:${HERO_ID}` },
			alt: "Hero",
		});
		expect(result.mediaIds).toEqual([HERO_ID]);
		expect(result.warnings).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	it("rewrites the dark variant of an image value", () => {
		const result = exportRecord(
			entry({
				featured_image: {
					id: HERO_ID,
					meta: { storageKey: HERO_KEY },
					darkVariant: { id: INLINE_ID, provider: "local", meta: { storageKey: INLINE_KEY } },
				},
			}),
		);
		expect(result.value.fields.featured_image).toEqual({
			id: HERO_ID,
			meta: { storageKey: `emdash-media:${HERO_ID}` },
			darkVariant: {
				id: INLINE_ID,
				provider: "local",
				meta: { storageKey: `emdash-media:${INLINE_ID}` },
			},
		});
		expect(result.mediaIds).toEqual([HERO_ID, INLINE_ID]);
	});

	it("rewrites media values whose id is the storage key", () => {
		const result = exportRecord(entry({ featured_image: { id: HERO_KEY, provider: "local" } }));
		expect(result.value.fields.featured_image).toEqual({
			id: `emdash-media:${HERO_ID}`,
			provider: "local",
		});
	});

	it("leaves a media id alone and ignores non-local providers", () => {
		const record = entry({
			featured_image: { id: HERO_ID, provider: "local" },
			cover: { id: HERO_KEY, provider: "cloudflare-images", meta: { storageKey: HERO_KEY } },
		});
		const result = exportRecord(record);
		expect(result.changed).toBe(false);
		expect(result.value).toBe(record);
	});

	it("rewrites Portable Text image and gallery assets and link marks", () => {
		const content = [
			{
				_type: "block",
				markDefs: [
					{
						_type: "link",
						_key: "l",
						href: `https://origin.example/_emdash/api/media/file/${INLINE_KEY}`,
					},
				],
				children: [{ _type: "span", text: "x" }],
			},
			{ _type: "image", asset: { _ref: INLINE_ID, url: `/_emdash/api/media/file/${INLINE_KEY}` } },
			{
				_type: "gallery",
				images: [
					{
						asset: {
							_ref: `/_emdash/api/media/file/${HERO_KEY}`,
							url: `/_emdash/api/media/file/${HERO_KEY}?w=400`,
						},
					},
				],
			},
		];
		const result = exportRecord(entry({ content }));
		expect(result.value.fields.content).toEqual([
			{
				_type: "block",
				markDefs: [
					{
						_type: "link",
						_key: "l",
						href: `https://origin.example/_emdash/api/media/file/emdash-media:${INLINE_ID}`,
					},
				],
				children: [{ _type: "span", text: "x" }],
			},
			{
				_type: "image",
				asset: { _ref: INLINE_ID, url: `/_emdash/api/media/file/emdash-media:${INLINE_ID}` },
			},
			{
				_type: "gallery",
				images: [
					{
						asset: {
							_ref: `/_emdash/api/media/file/emdash-media:${HERO_ID}`,
							url: `/_emdash/api/media/file/emdash-media:${HERO_ID}?w=400`,
						},
					},
				],
			},
		]);
	});

	it("rewrites repeater sub-field images and JSON field values", () => {
		const result = exportRecord(
			entry({
				gallery: [{ photo: { id: HERO_ID, meta: { storageKey: HERO_KEY } }, caption: "One" }],
				metadata: { deep: { list: [{ url: `/_emdash/api/media/file/${INLINE_KEY}` }] } },
			}),
		);
		expect(result.value.fields.gallery).toEqual([
			{ photo: { id: HERO_ID, meta: { storageKey: `emdash-media:${HERO_ID}` } }, caption: "One" },
		]);
		expect(result.value.fields.metadata).toEqual({
			deep: { list: [{ url: `/_emdash/api/media/file/emdash-media:${INLINE_ID}` }] },
		});
	});

	it("rewrites a bare key only where a bare key is a media reference", () => {
		const seo = rewriteMediaRefs(
			{
				kind: "seo",
				id: "posts:1",
				collection: "posts",
				entryId: "1",
				seoImage: HERO_KEY,
				seoTitle: HERO_KEY,
				seoNoIndex: false,
				createdAt: "t",
				updatedAt: "t",
			},
			{ mode: "export", keys },
		);
		expect(seo.value.seoImage).toBe(`emdash-media:${HERO_ID}`);
		expect(seo.value.seoTitle).toBe(HERO_KEY);

		const fields = exportRecord(entry({ featured_image: HERO_KEY }));
		expect(fields.value.fields.featured_image).toBe(`emdash-media:${HERO_ID}`);

		const nested = exportRecord(entry({ list: [HERO_KEY] }));
		expect(nested.value.fields.list).toEqual([HERO_KEY]);
	});

	it("never rewrites identity properties", () => {
		const record = {
			kind: "entry",
			id: HERO_KEY,
			collection: "posts",
			locale: "en",
			translationGroup: HERO_KEY,
			fields: {},
		} as const;
		expect(exportRecord(record).changed).toBe(false);
	});

	it("warns about unknown keys and leaves them untouched", () => {
		const result = exportRecord(
			entry({
				content: [{ _type: "image", asset: { url: "/_emdash/api/media/file/missing.jpg" } }],
				featured_image: { id: HERO_ID, meta: { storageKey: "gone.jpg" } },
			}),
		);
		expect(result.changed).toBe(false);
		expect(result.warnings.map((warning) => `${warning.code}:${warning.value}`).toSorted()).toEqual(
			["unknown_storage_key:gone.jpg", "unknown_storage_key:missing.jpg"],
		);
	});

	it("does not warn when a media file URL uses a media id", () => {
		const result = exportRecord(entry({ body: `/_emdash/api/media/file/${HERO_ID}` }));
		expect(result.warnings).toEqual([]);
		expect(result.changed).toBe(false);
	});

	it("escapes placeholder text the origin already holds", () => {
		const result = exportRecord(entry({ body: "see emdash-media:01ABC or emdash-media::x" }));
		expect(result.errors).toEqual([]);
		expect(result.value.fields.body).toBe("see emdash-media::01ABC or emdash-media:::x");
		expect(result.mediaIds).toEqual([]);
	});

	it("reports media ids that cannot be written as placeholders", () => {
		const index = buildMediaKeyIndex([{ id: "bad id", storageKey: "k.jpg" }]);
		const result = rewriteMediaRefs(entry({ body: "/_emdash/api/media/file/k.jpg" }), {
			mode: "export",
			keys: index,
		});
		expect(result.errors[0]?.code).toBe("media_id_not_placeholderable");
	});

	it("leaves strings that only look like JSON alone", () => {
		const record = entry({ note: "[not json /_emdash/api/media/file/nope" });
		const result = exportRecord(record);
		expect(result.value.fields.note).toBe("[not json /_emdash/api/media/file/nope");
		expect(result.warnings[0]?.code).toBe("unknown_storage_key");
	});

	it("rewrites settings, widgets, sections, and revisions the same way", () => {
		const revision = rewriteMediaRefs(
			{
				kind: "revision",
				id: "r",
				collection: "posts",
				entryId: "e",
				data: { featured_image: { id: HERO_KEY }, body: `/_emdash/api/media/file/${HERO_KEY}` },
			},
			{ mode: "export", keys },
		);
		expect(revision.value.data).toEqual({
			featured_image: { id: `emdash-media:${HERO_ID}` },
			body: `/_emdash/api/media/file/emdash-media:${HERO_ID}`,
		});

		const setting = rewriteMediaRefs(
			{
				kind: "setting",
				id: "site:seo",
				value: { robotsTxt: `Sitemap: /_emdash/api/media/file/${INLINE_KEY}` },
			},
			{ mode: "export", keys },
		);
		expect(setting.value.value).toEqual({
			robotsTxt: `Sitemap: /_emdash/api/media/file/emdash-media:${INLINE_ID}`,
		});
	});
});

describe("rewriteMediaRefs import and verify modes", () => {
	it("resolves placeholders anywhere, including inside JSON text", () => {
		const exported = exportRecord(
			entry({
				featured_image: JSON.stringify({ id: HERO_ID, meta: { storageKey: HERO_KEY } }),
				content: [{ _type: "image", asset: { url: `/_emdash/api/media/file/${INLINE_KEY}` } }],
			}),
		).value;
		const imported = rewriteMediaRefs(exported, { mode: "import", mediaIdToKey: targetKeys });
		expect(imported.errors).toEqual([]);
		expect(JSON.parse(stringValue(imported.value.fields.featured_image)).meta.storageKey).toBe(
			targetKeys.get(HERO_ID),
		);
		expect(imported.value.fields.content).toEqual([
			{ _type: "image", asset: { url: `/_emdash/api/media/file/${targetKeys.get(INLINE_ID)}` } },
		]);
		expect(imported.mediaIds).toEqual([HERO_ID, INLINE_ID]);
	});

	it("imports absolute placeholder URLs as the target's relative media route", () => {
		const imported = rewriteMediaRefs(
			entry({
				body: `See https://origin.example:8080/_emdash/api/media/file/emdash-media:${HERO_ID} and //cdn.example/_emdash/api/media/file/emdash-media:${INLINE_ID}?w=2`,
				other: "https://origin.example/_emdash/api/media/file/unrelated.png",
			}),
			{ mode: "import", mediaIdToKey: targetKeys },
		);
		expect(imported.errors).toEqual([]);
		expect(imported.value.fields).toEqual({
			body: `See /_emdash/api/media/file/${targetKeys.get(HERO_ID)} and /_emdash/api/media/file/${targetKeys.get(INLINE_ID)}?w=2`,
			other: "https://origin.example/_emdash/api/media/file/unrelated.png",
		});
	});

	it("reports placeholders with no target key", () => {
		const result = rewriteMediaRefs(entry({ body: "emdash-media:01UNKNOWN" }), {
			mode: "import",
			mediaIdToKey: targetKeys,
		});
		expect(result.errors).toEqual([
			{ code: "unresolved_placeholder", path: "fields.body", value: "01UNKNOWN" },
		]);
	});

	it("verify mode maps the imported record back to the exported record", () => {
		const original = entry({
			featured_image: JSON.stringify({
				id: HERO_ID,
				provider: "local",
				meta: { storageKey: HERO_KEY },
			}),
			legacy: { id: HERO_KEY },
			bare: INLINE_KEY,
			content: [
				{
					_type: "image",
					asset: { _ref: INLINE_ID, url: `/_emdash/api/media/file/${INLINE_KEY}` },
				},
			],
		});
		const exported = exportRecord(original).value;
		const imported = rewriteMediaRefs(exported, { mode: "import", mediaIdToKey: targetKeys }).value;
		const verified = rewriteMediaRefs(imported, {
			mode: "verify",
			keys: buildMediaKeyIndex(Array.from(targetKeys, ([id, storageKey]) => ({ id, storageKey }))),
		});
		expect(verified.errors).toEqual([]);
		expect(verified.value).toEqual(exported);
	});

	it("verify mode does not mistake a placeholder left in the target for the package's", () => {
		const packaged = entry({ body: `emdash-media:${HERO_ID}` });
		const result = rewriteMediaRefs(packaged, { mode: "verify", keys });
		expect(result.errors).toEqual([]);
		expect(result.value).not.toEqual(packaged);
	});

	it("round-trips literal placeholder text exactly through export, import, and verify", () => {
		const targetIndex = buildMediaKeyIndex(
			Array.from(targetKeys, ([id, storageKey]) => ({ id, storageKey })),
		);
		const literals = [
			"see emdash-media:01ABC",
			"emdash-media::x, emdash-media:::, and a bare emdash-media:",
			`{ "note": "emdash-media:q", "n": 1 }`,
			`["emdash-media\\u003aq"]`,
			`/_emdash/api/media/file/emdash-media:${HERO_ID}`,
			`https://elsewhere.example/_emdash/api/media/file/emdash-media:${HERO_ID}`,
		];
		for (const body of literals) {
			const original = entry({ body });
			const exported = rewriteMediaRefs(original, { mode: "export", keys, relativize: true });
			expect(exported.errors).toEqual([]);
			expect(exported.mediaIds).toEqual([]);
			const imported = rewriteMediaRefs(exported.value, {
				mode: "import",
				mediaIdToKey: targetKeys,
			});
			expect(imported.errors).toEqual([]);
			expect(imported.value).toEqual(original);
			const verified = rewriteMediaRefs(imported.value, {
				mode: "verify",
				keys: targetIndex,
				relativize: true,
			});
			expect(verified.value).toEqual(exported.value);
		}
	});

	it("keeps literal placeholder text next to rewritten media references", () => {
		const targetIndex = buildMediaKeyIndex(
			Array.from(targetKeys, ([id, storageKey]) => ({ id, storageKey })),
		);
		const original = entry({
			body: `emdash-media:${HERO_ID} is not /_emdash/api/media/file/${HERO_KEY}`,
			image: JSON.stringify({
				id: HERO_ID,
				provider: "local",
				alt: "emdash-media:alt",
				meta: { storageKey: HERO_KEY },
			}),
		});
		const exported = rewriteMediaRefs(original, { mode: "export", keys, relativize: true });
		expect(exported.errors).toEqual([]);
		expect(exported.mediaIds).toEqual([HERO_ID]);
		const imported = rewriteMediaRefs(exported.value, {
			mode: "import",
			mediaIdToKey: targetKeys,
		}).value;
		const targetHero = targetKeys.get(HERO_ID)!;
		expect(imported.fields.body).toBe(
			`emdash-media:${HERO_ID} is not /_emdash/api/media/file/${targetHero}`,
		);
		expect(JSON.parse(stringValue(imported.fields.image))).toEqual({
			id: HERO_ID,
			provider: "local",
			alt: "emdash-media:alt",
			meta: { storageKey: targetHero },
		});
		const verified = rewriteMediaRefs(imported, {
			mode: "verify",
			keys: targetIndex,
			relativize: true,
		});
		expect(verified.value).toEqual(exported.value);
	});
});

describe("scanForKeys", () => {
	it("finds keys as substrings anywhere in text", () => {
		const scan = scannableKeys(keys);
		const text = JSON.stringify({ a: `x${HERO_KEY}y`, b: `https://cdn/${INLINE_KEY}?q` });
		expect(scanForKeys(text, scan)).toEqual([HERO_KEY, INLINE_KEY].toSorted());
		expect(scanForKeys(JSON.stringify({ a: `emdash-media:${HERO_ID}` }), scan)).toEqual([]);
	});

	it("excludes keys equal to a media id and handles keys outside the usual alphabet", () => {
		const index = buildMediaKeyIndex([
			{ id: "01SAME", storageKey: "01SAME" },
			{ id: "01ODD", storageKey: "odd key+name.jpg" },
		]);
		const scan = scannableKeys(index);
		expect(scan.has("01SAME")).toBe(false);
		expect(scanForKeys("found odd key+name.jpg here and 01SAME", scan)).toEqual([
			"odd key+name.jpg",
		]);
	});
});

describe("storage keys outside the ULID alphabet", () => {
	const SPACED_ID = "01HZ0000000000000000000180";
	const SPACED_KEY = "01HZCCCCCCCCCCCCCCCCCCCCCC.my photo(1).jpg";
	const UNICODE_ID = "01HZ0000000000000000000181";
	const UNICODE_KEY = "01HZDDDDDDDDDDDDDDDDDDDDDD.fotó+1.png";
	const odd = buildMediaKeyIndex([
		{ id: HERO_ID, storageKey: HERO_KEY },
		{ id: SPACED_ID, storageKey: SPACED_KEY },
		{ id: UNICODE_ID, storageKey: UNICODE_KEY },
	]);

	function exportOdd(record: EntryRecord) {
		return rewriteMediaRefs(record, { mode: "export", keys: odd });
	}

	it("rewrites raw keys containing spaces, parentheses, plus signs, and non-ASCII", () => {
		const result = exportOdd(
			entry({
				body: `<img src="/_emdash/api/media/file/${SPACED_KEY}"> and /_emdash/api/media/file/${UNICODE_KEY}?w=10`,
			}),
		);
		expect(result.value.fields.body).toBe(
			`<img src="/_emdash/api/media/file/emdash-media:${SPACED_ID}"> and /_emdash/api/media/file/emdash-media:${UNICODE_ID}?w=10`,
		);
		expect(result.warnings).toEqual([]);
		expect(scanForKeys(JSON.stringify(result.value), scannableKeys(odd))).toEqual([]);
	});

	it("rewrites percent-encoded keys", () => {
		const encoded = encodeURIComponent(SPACED_KEY);
		const result = exportOdd(
			entry({ body: `https://origin.example/_emdash/api/media/file/${encoded}#x` }),
		);
		expect(result.value.fields.body).toBe(
			`https://origin.example/_emdash/api/media/file/emdash-media:${SPACED_ID}#x`,
		);
	});

	it("rewrites keys followed by punctuation or a markdown parenthesis", () => {
		const result = exportOdd(
			entry({
				body: `See /_emdash/api/media/file/${HERO_KEY}. And [x](/_emdash/api/media/file/${HERO_KEY}) too`,
			}),
		);
		expect(result.value.fields.body).toBe(
			`See /_emdash/api/media/file/emdash-media:${HERO_ID}. And [x](/_emdash/api/media/file/emdash-media:${HERO_ID}) too`,
		);
	});

	it("finds leftover keys in raw, percent-encoded, and JSON-escaped form", () => {
		const scan = scannableKeys(odd);
		expect(scanForKeys(`x ${encodeURIComponent(UNICODE_KEY)} y`, scan)).toEqual([UNICODE_KEY]);
		const lowerHex = encodeURIComponent(SPACED_KEY).replace(/%[0-9A-F]{2}/g, (escape) =>
			escape.toLowerCase(),
		);
		expect(scanForKeys(`x ${lowerHex} y`, scan)).toEqual([SPACED_KEY]);
		expect(scanForKeys(`x ${encodeURI(SPACED_KEY)} y`, scan)).toEqual([SPACED_KEY]);
		expect(scanForKeys("%30%31HZAAAAAAAAAAAAAAAAAAAAAA.jpg", scan)).toEqual([HERO_KEY]);
	});
});

describe("record strings as long as a record line allows", () => {
	const SIZE = 1_900_000;
	const LIMIT_MS = 1000;
	const letters = "a".repeat(SIZE);

	function timed(run: () => void): number {
		const started = performance.now();
		run();
		return performance.now() - started;
	}

	it("relativizes a media URL after a long run of scheme characters in linear time", () => {
		const body = `${letters}/_emdash/api/media/file/${HERO_KEY}`;
		let rewritten: unknown;
		const elapsed = timed(() => {
			rewritten = rewriteMediaRefs(entry({ body }), { mode: "export", keys, relativize: true })
				.value.fields.body;
		});
		expect(elapsed).toBeLessThan(LIMIT_MS);
		expect(rewritten).toBe(`${letters}/_emdash/api/media/file/emdash-media:${HERO_ID}`);
	});

	it("resolves a placeholder URL after a long run of scheme characters in linear time", () => {
		const body = `${letters}/_emdash/api/media/file/emdash-media:${HERO_ID}`;
		let resolved: unknown;
		const elapsed = timed(() => {
			resolved = rewriteMediaRefs(entry({ body }), { mode: "import", mediaIdToKey: targetKeys })
				.value.fields.body;
		});
		expect(elapsed).toBeLessThan(LIMIT_MS);
		expect(resolved).toBe(`${letters}/_emdash/api/media/file/${targetKeys.get(HERO_ID)}`);
		expect(timed(() => relativizePlaceholderUrls(body))).toBeLessThan(LIMIT_MS);
	});

	it.each([
		["unterminated", "/_emdash/api/media/file/x"],
		["percent-encoded", `/_emdash/api/media/file/${"%41".repeat(40)}`],
	])("scans many %s media URLs in linear time", (_, url) => {
		const body = url.repeat(Math.floor(SIZE / url.length));
		expect(
			timed(() => void rewriteMediaRefs(entry({ body }), { mode: "export", keys })),
		).toBeLessThan(LIMIT_MS);
	});

	it("scans many absolute media URLs in linear time", () => {
		const url = `https://${"h".repeat(40)}/_emdash/api/media/file/${HERO_KEY}`;
		const body = url.repeat(Math.floor(SIZE / url.length));
		expect(
			timed(
				() => void rewriteMediaRefs(entry({ body }), { mode: "export", keys, relativize: true }),
			),
		).toBeLessThan(LIMIT_MS);
		const placeholders = body.replaceAll(HERO_KEY, `emdash-media:${HERO_ID}`);
		expect(timed(() => void relativizePlaceholderUrls(placeholders))).toBeLessThan(LIMIT_MS);
	});
});
