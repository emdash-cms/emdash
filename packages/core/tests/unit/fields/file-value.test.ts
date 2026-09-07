import { describe, expect, it } from "vitest";

import { file, type FileValue } from "../../../src/fields/index.js";
import { normalizeMediaValue } from "../../../src/media/normalize.js";
import type { Field } from "../../../src/schema/types.js";
import { generateFieldSchema } from "../../../src/schema/zod-generator.js";

const persistedLocalFile: FileValue = {
	id: "01KFILEVALUE00000000000000",
	provider: "local",
	filename: "report.pdf",
	mimeType: "application/pdf",
	meta: {
		storageKey: "01KFILEVALUE00000000000000.pdf",
		caption: null,
		custom: { source: "archive" },
	},
};

const fileField: Field = {
	id: "field-file",
	collectionId: "collection-docs",
	slug: "attachment",
	label: "Attachment",
	type: "file",
	columnType: "TEXT",
	required: true,
	unique: false,
	sortOrder: 0,
	createdAt: "2026-08-16T00:00:00.000Z",
};

describe("FileValue persistence", () => {
	it("round-trips a persisted local file without hydrated URL or size", () => {
		const schema = file({ required: true }).schema;
		const storedValue = JSON.parse(JSON.stringify(persistedLocalFile));

		expect(schema.parse(storedValue)).toEqual(persistedLocalFile);
	});

	it("preserves legacy cached URLs through generated collection validation", () => {
		const value: FileValue = {
			...persistedLocalFile,
			url: "https://media.example.com/01KFILEVALUE00000000000000.pdf",
			size: 102_400,
		};
		const storedValue = JSON.parse(JSON.stringify(value));

		expect(generateFieldSchema(fileField).parse(storedValue)).toEqual(value);
	});

	it("round-trips a sparse external file produced by normalization", async () => {
		const normalized = await normalizeMediaValue(
			"https://files.example.com/report.pdf",
			() => undefined,
		);
		if (!normalized) throw new Error("Expected a normalized file value");
		const fileValue: FileValue = normalized;
		const storedValue = JSON.parse(JSON.stringify(fileValue));

		expect(file({ required: true }).schema.parse(storedValue)).toEqual(fileValue);
	});
});
