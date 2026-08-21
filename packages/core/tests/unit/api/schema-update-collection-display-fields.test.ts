import { describe, it, expect } from "vitest";

import {
	collectionSchema,
	updateCollectionBody,
} from "../../../src/api/schemas/index.js";

describe("updateCollectionBody display fields", () => {
	it("preserves titleField and dateField so the PUT reaches the registry", () => {
		const result = updateCollectionBody.parse({
			titleField: "run_status",
			dateField: "started_at",
		});
		expect(result.titleField).toBe("run_status");
		expect(result.dateField).toBe("started_at");
	});

	it("accepts null to clear titleField/dateField back to defaults", () => {
		const result = updateCollectionBody.parse({
			titleField: null,
			dateField: null,
		});
		expect(result.titleField).toBeNull();
		expect(result.dateField).toBeNull();
	});

	it("rejects titleField and dateField that do not match the slug pattern", () => {
		expect(() => updateCollectionBody.parse({ titleField: "invalid slug" })).toThrow();
		expect(() => updateCollectionBody.parse({ dateField: "also invalid" })).toThrow();
	});
});

describe("collectionSchema display fields", () => {
	it("includes titleField and dateField on the response contract", () => {
		const result = collectionSchema.parse({
			id: "col_1",
			slug: "import_runs",
			label: "Import runs",
			labelSingular: null,
			description: null,
			icon: null,
			supports: ["drafts"],
			source: null,
			urlPattern: null,
			routable: true,
			hasSeo: false,
			hidden: false,
			sortOrder: null,
			createdAt: "2026-08-20T00:00:00Z",
			updatedAt: "2026-08-20T00:00:00Z",
			titleField: "run_status",
			dateField: "started_at",
		});
		expect(result.titleField).toBe("run_status");
		expect(result.dateField).toBe("started_at");
	});

	it("allows nullable titleField and dateField", () => {
		const result = collectionSchema.parse({
			id: "col_1",
			slug: "import_runs",
			label: "Import runs",
			labelSingular: null,
			description: null,
			icon: null,
			supports: ["drafts"],
			source: null,
			urlPattern: null,
			routable: true,
			hasSeo: false,
			hidden: false,
			sortOrder: null,
			createdAt: "2026-08-20T00:00:00Z",
			updatedAt: "2026-08-20T00:00:00Z",
			titleField: null,
			dateField: null,
		});
		expect(result.titleField).toBeNull();
		expect(result.dateField).toBeNull();
	});
});
