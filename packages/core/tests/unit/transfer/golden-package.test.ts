import { describe, expect, it } from "vitest";

import { sha256Hex } from "../../../src/transfer/format/digest.js";
import {
	blocksFieldTypeSlugs,
	blockTypeVersionKey,
	compareStreamOrder,
	KIND_REFERENCES,
	RECORD_KINDS,
	type RecordKind,
	type ReferenceKey,
	type SitePackageRecord,
} from "../../../src/transfer/format/kinds.js";
import { MEDIA_PLACEHOLDER_PREFIX } from "../../../src/transfer/format/media-refs.js";
import { parsePackagePath } from "../../../src/transfer/format/paths.js";
import {
	buildGoldenPackage,
	GOLDEN_IDS,
	GOLDEN_MEDIA_BYTES,
} from "../../utils/transfer/golden-package.js";
import { createMemoryStorage } from "../../utils/transfer/memory-storage.js";

describe("golden package", () => {
	it("contains every record kind and passes every strict schema when read back", async () => {
		const golden = await buildGoldenPackage(createMemoryStorage());
		for (const kind of RECORD_KINDS) {
			const read: SitePackageRecord[] = [];
			for await (const staged of golden.reader.records(kind)) read.push(staged.record);
			expect(read.length, kind).toBeGreaterThan(0);
			expect(read).toEqual(golden.records[kind]);
			expect(golden.manifest.records[kind]?.count).toBe(read.length);
		}
	});

	it("is deterministic", async () => {
		const first = await buildGoldenPackage(createMemoryStorage());
		const second = await buildGoldenPackage(createMemoryStorage(), { prefix: "elsewhere/" });
		expect(second.digest).toBe(first.digest);
	});

	it("declares features, locales, and every staged file in the index", async () => {
		const storage = createMemoryStorage();
		const golden = await buildGoldenPackage(storage);
		expect(golden.manifest.features).toContain("i18n");
		expect(golden.manifest.features).toContain("trash");
		expect(golden.manifest.requiredFeatures).not.toContain("comment_reactions");
		expect(golden.manifest.locales).toEqual({ default: "en", used: ["en", "fr"] });

		const indexed: string[] = [];
		for await (const { entry } of golden.reader.index()) indexed.push(entry.path);
		const staged = Array.from(storage.files.keys(), (key) =>
			key.slice(golden.stage.prefix.length),
		).filter(
			(path) =>
				parsePackagePath(path)?.type === "records" || parsePackagePath(path)?.type === "media",
		);
		expect(indexed.toSorted()).toEqual(staged.toSorted());
		expect(indexed).toEqual(indexed.toSorted());
		expect(golden.manifest.media.count).toBe(3);
	});

	it("stores media bytes under their digest, deduplicated", async () => {
		const golden = await buildGoldenPackage(createMemoryStorage());
		expect(golden.blobs.get(GOLDEN_IDS.heroMedia)).toBe(golden.blobs.get(GOLDEN_IDS.avatarMedia));
		for (const [mediaId, bytes] of Object.entries(GOLDEN_MEDIA_BYTES)) {
			const stream = await golden.reader.blob(golden.blobs.get(mediaId)!);
			const stored = new Uint8Array(await new Response(stream).arrayBuffer());
			expect(await sha256Hex(stored)).toBe(golden.blobs.get(mediaId));
			expect(stored).toEqual(bytes);
		}
	});

	it("has no dangling references and keeps parents before children", async () => {
		const golden = await buildGoldenPackage(createMemoryStorage());
		const lookup = (kind: RecordKind, by: ReferenceKey): Set<string> => {
			const values = new Set<string>();
			for (const record of golden.records[kind]) {
				const property = { id: "id", group: "translationGroup", slug: "slug", name: "name" }[by];
				const value: unknown = Reflect.get(record, property);
				if (typeof value === "string") values.add(value);
				else if (by === "group") values.add(record.id);
			}
			return values;
		};
		for (const kind of RECORD_KINDS) {
			const seen = new Set<string>();
			for (const record of golden.records[kind]) {
				for (const reference of KIND_REFERENCES[kind]) {
					const raw: unknown = Reflect.get(record, reference.property);
					if (raw === undefined) continue;
					const values: unknown[] = Array.isArray(raw) ? raw : [raw];
					const targets = new Set(
						reference.targets.flatMap((target) => [...lookup(target, reference.by)]),
					);
					for (const value of values) {
						if (typeof value !== "string") throw new Error("reference is not a string");
						expect(targets.has(value), `${kind} ${record.id} ${reference.property}`).toBe(true);
						if (reference.targets.includes(kind) && reference.property === "parentId") {
							expect(seen.has(value), `${kind} ${record.id} parent order`).toBe(true);
						}
					}
				}
				seen.add(record.id);
			}
		}
	});

	it("resolves block type references held inside fields and block types", async () => {
		const golden = await buildGoldenPackage(createMemoryStorage());
		const slugs = new Set(
			golden.records.block_type.flatMap((record) =>
				record.kind === "block_type" ? [record.slug] : [],
			),
		);
		const versions = new Set(
			golden.records.block_type_version.flatMap((record) =>
				record.kind === "block_type_version"
					? [blockTypeVersionKey(record.blockTypeId, record.version)]
					: [],
			),
		);
		const referenced = golden.records.field.flatMap((record) =>
			record.kind === "field" ? blocksFieldTypeSlugs(record) : [],
		);
		expect(referenced.toSorted()).toEqual(["callout", "quote"]);
		for (const slug of referenced) expect(slugs.has(slug), slug).toBe(true);
		for (const record of golden.records.block_type) {
			if (record.kind !== "block_type") continue;
			expect(versions.has(blockTypeVersionKey(record.id, record.currentVersion))).toBe(true);
		}
	});

	it("references media only through placeholders naming packaged media", async () => {
		const golden = await buildGoldenPackage(createMemoryStorage());
		const mediaIds = new Set(golden.records.media.map((record) => record.id));
		const text = JSON.stringify(golden.records);
		const placeholders = Array.from(
			text.matchAll(/emdash-media:([0-9A-Za-z_-]+)/g),
			(match) => match[1] ?? "",
		);
		expect(placeholders.length).toBeGreaterThan(5);
		for (const id of placeholders) expect(mediaIds.has(id)).toBe(true);
		expect(text.includes(MEDIA_PLACEHOLDER_PREFIX)).toBe(true);
	});

	it("streams each kind in stream order", async () => {
		const golden = await buildGoldenPackage(createMemoryStorage());
		expect(golden.records.comment.map((record) => record.id)).toEqual([
			GOLDEN_IDS.rootComment,
			GOLDEN_IDS.replyComment,
			GOLDEN_IDS.nestedReply,
		]);
		expect(golden.records.entry.map((record) => record.id)).toEqual(
			golden.records.entry.map((record) => record.id).toSorted(),
		);
		expect(
			compareStreamOrder(
				"term",
				{ id: GOLDEN_IDS.newsFr, depth: 0 },
				{ id: GOLDEN_IDS.worldEn, depth: 1 },
			),
		).toBeLessThan(0);
	});
});
