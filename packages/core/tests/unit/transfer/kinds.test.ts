import { describe, expect, it } from "vitest";

import {
	CONTENT_TABLE_COLUMNS,
	PORTABLE_TABLES,
	getPortableTableSpecForKind,
} from "../../../src/transfer/format/columns.js";
import { KIND_FEATURE, SITE_PACKAGE_FEATURES } from "../../../src/transfer/format/features.js";
import {
	blocksFieldTypeSlugs,
	compareIds,
	compareStreamOrder,
	identityProperties,
	IMPORT_STAGE_KINDS,
	KIND_REFERENCES,
	NON_IMPORTED_KINDS,
	RECORD_KINDS,
	RECORD_SCHEMAS,
	syntheticId,
	validateRecord,
	type RecordKind,
} from "../../../src/transfer/format/kinds.js";

function shapeKeys(kind: RecordKind): string[] {
	return Object.keys(RECORD_SCHEMAS[kind].shape);
}

const SYNTHETIC_OR_DERIVED_PROPERTIES: Partial<Record<RecordKind, string[]>> = {
	content_term: ["id"],
	seo: ["id"],
	byline_field_value: ["id"],
	byline_field_group_value: ["id"],
	media: ["blob"],
};

describe("record kind registry", () => {
	it("every kind except principal and entry maps to exactly one portable table", () => {
		for (const kind of RECORD_KINDS) {
			const spec = getPortableTableSpecForKind(kind);
			if (kind === "principal" || kind === "entry") expect(spec).toBeUndefined();
			else expect(spec, kind).toBeDefined();
		}
		expect(new Set(PORTABLE_TABLES.map((spec) => spec.kind)).size).toBe(PORTABLE_TABLES.length);
	});

	it("record schemas and the column registry describe the same properties", () => {
		for (const spec of PORTABLE_TABLES) {
			const shape = new Set(shapeKeys(spec.kind));
			const produced = new Set(["kind", ...(SYNTHETIC_OR_DERIVED_PROPERTIES[spec.kind] ?? [])]);
			for (const [column, columnSpec] of Object.entries(spec.columns)) {
				if (!("property" in columnSpec)) continue;
				expect(shape.has(columnSpec.property), `${spec.table}.${column}`).toBe(true);
				produced.add(columnSpec.property);
			}
			for (const property of shape) {
				expect(produced.has(property), `${spec.kind}.${property} has no source column`).toBe(true);
			}
		}

		const entryShape = new Set(shapeKeys("entry"));
		const entryProduced = new Set(["kind", "collection", "fields"]);
		for (const columnSpec of Object.values(CONTENT_TABLE_COLUMNS)) {
			if (!("property" in columnSpec)) continue;
			expect(entryShape.has(columnSpec.property), columnSpec.property).toBe(true);
			entryProduced.add(columnSpec.property);
		}
		for (const property of entryShape) expect(entryProduced.has(property), property).toBe(true);
	});

	it("every reference names a property of its kind", () => {
		for (const kind of RECORD_KINDS) {
			const shape = new Set(shapeKeys(kind));
			for (const reference of KIND_REFERENCES[kind]) {
				expect(shape.has(reference.property), `${kind}.${reference.property}`).toBe(true);
			}
		}
	});

	it("every kind is imported by exactly one stage, in package order", () => {
		const imported = Object.values(IMPORT_STAGE_KINDS).flat();
		expect([...imported, ...NON_IMPORTED_KINDS].toSorted()).toEqual(RECORD_KINDS.toSorted());
		expect(new Set(imported).size).toBe(imported.length);
		const order = RECORD_KINDS.filter((kind) => !NON_IMPORTED_KINDS.includes(kind));
		expect(imported).toEqual(order);
	});

	it("gives every feature but i18n and trash at least one kind", () => {
		const mapped = new Set(RECORD_KINDS.map((kind) => KIND_FEATURE[kind]));
		expect(SITE_PACKAGE_FEATURES.filter((feature) => !mapped.has(feature))).toEqual([
			"i18n",
			"trash",
		]);
	});

	it("reads block type slugs only from a blocks field's allowed and retired types", () => {
		const field = {
			kind: "field",
			id: "F1",
			collectionId: "C1",
			slug: "body",
			label: "Body",
			type: "blocks",
			columnType: "JSON",
			translatable: true,
			indexed: false,
			validation: { allowedTypes: ["callout", 7], retiredTypes: ["quote", "callout"], maxItems: 3 },
		} as const;
		expect(blocksFieldTypeSlugs(field)).toEqual(["callout", "quote"]);
		expect(blocksFieldTypeSlugs({ ...field, type: "json" })).toEqual([]);
		expect(blocksFieldTypeSlugs({ ...field, validation: ["callout"] })).toEqual([]);
	});

	it("identity properties include ids and references but not content", () => {
		const entry = identityProperties("entry");
		expect(entry.has("id")).toBe(true);
		expect(entry.has("liveRevisionId")).toBe(true);
		expect(entry.has("fields")).toBe(false);
		expect(identityProperties("media").has("blob")).toBe(true);
	});
});

describe("ordering", () => {
	it("compares ids by UTF-16 code unit", () => {
		expect(compareIds("01A", "01B")).toBeLessThan(0);
		expect(compareIds("B", "a")).toBeLessThan(0);
		expect(compareIds("x", "x")).toBe(0);
	});

	it("orders topological kinds by depth then id, and flat kinds by id only", () => {
		expect(compareStreamOrder("term", { id: "b", depth: 0 }, { id: "a", depth: 1 })).toBeLessThan(
			0,
		);
		expect(compareStreamOrder("term", { id: "a", depth: 1 }, { id: "b", depth: 1 })).toBeLessThan(
			0,
		);
		expect(
			compareStreamOrder("entry", { id: "b", depth: 0 }, { id: "a", depth: 1 }),
		).toBeGreaterThan(0);
	});
});

describe("validateRecord", () => {
	const minimalEntry = {
		kind: "entry",
		id: "01HZ1",
		collection: "posts",
		locale: "en",
		fields: {},
	};

	it("accepts a minimal record", () => {
		expect(validateRecord("entry", minimalEntry).success).toBe(true);
	});

	it("rejects unknown properties, wrong kinds, null for absent columns, and unsafe identifiers", () => {
		expect(validateRecord("entry", { ...minimalEntry, extra: 1 }).success).toBe(false);
		expect(validateRecord("entry", { ...minimalEntry, kind: "revision" }).success).toBe(false);
		expect(validateRecord("entry", { ...minimalEntry, slug: null }).success).toBe(false);
		expect(
			validateRecord("entry", { ...minimalEntry, collection: "posts; DROP TABLE" }).success,
		).toBe(false);
		expect(validateRecord("entry", { ...minimalEntry, fields: { "bad-slug": 1 } }).success).toBe(
			false,
		);
		expect(validateRecord("entry", { ...minimalEntry, id: "has space" }).success).toBe(false);
		expect(validateRecord("entry", { ...minimalEntry, id: "é" }).success).toBe(false);
	});

	it("rejects settings outside the portable allowlist", () => {
		expect(
			validateRecord("setting", { kind: "setting", id: "site:title", value: "x" }).success,
		).toBe(true);
		expect(validateRecord("setting", { kind: "setting", id: "site:url", value: "x" }).success).toBe(
			false,
		);
		expect(
			validateRecord("setting", { kind: "setting", id: "plugin:x:secret", value: "x" }).success,
		).toBe(false);
	});

	it("enforces synthetic ids", () => {
		const record = {
			kind: "content_term",
			collection: "posts",
			entryGroup: "E1",
			termGroup: "T1",
		} as const;
		expect(syntheticId(record)).toBe("posts:E1:T1");
		expect(validateRecord("content_term", { ...record, id: "posts:E1:T1" }).success).toBe(true);
		const mismatch = validateRecord("content_term", { ...record, id: "posts:E1:T2" });
		expect(mismatch.success).toBe(false);
		if (!mismatch.success) expect(mismatch.issues[0]?.path).toBe("id");
	});

	it("never echoes record values in issues", () => {
		const result = validateRecord("entry", { ...minimalEntry, slug: 42, secretish: "hunter2" });
		expect(result.success).toBe(false);
		expect(JSON.stringify(result)).not.toContain("hunter2");
	});

	it("never echoes unknown property names or nested keys in issues", () => {
		const sentinel = "SENTINEL_d41c";
		for (const record of [
			{ ...minimalEntry, [sentinel]: 1 },
			{ ...minimalEntry, fields: { [sentinel]: { [`${sentinel}-x`]: Number.NaN } } },
			{ ...minimalEntry, fields: { [`${sentinel}-bad`]: 1 } },
		]) {
			const result = validateRecord("entry", record);
			expect(result.success).toBe(false);
			expect(JSON.stringify(result)).not.toContain(sentinel);
		}
		const typed = validateRecord("entry", { ...minimalEntry, slug: 42 });
		expect(typed.success ? null : typed.issues[0]?.path).toBe("slug");
	});
});
