/**
 * Datetime fields represent instants. Storage migration 079 canonicalizes
 * legacy naive/date-only values before this validation requires an explicit
 * offset, while the admin converts its datetime-local input using the site
 * timezone before sending it.
 */
import { describe, it, expect, beforeEach } from "vitest";

import type { Field } from "../../../src/schema/types.js";
import { generateFieldSchema, clearSchemaCache } from "../../../src/schema/zod-generator.js";

function datetimeField(overrides: Partial<Field> = {}): Field {
	return {
		id: "f1",
		collectionId: "c1",
		slug: "event_at",
		label: "Event at",
		type: "datetime",
		columnType: "TEXT",
		required: true,
		unique: false,
		sortOrder: 0,
		createdAt: "2024-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("zod-generator datetime validation (issue #1368)", () => {
	beforeEach(() => {
		clearSchemaCache();
	});

	const accepted = [
		["ISO with milliseconds and Z (admin-edited)", "2024-01-15T14:30:00.000Z"],
		["ISO with Z, no milliseconds", "2024-01-15T14:30:00Z"],
		["minute-precision ISO with Z", "2024-01-15T14:30Z"],
		["ISO with timezone offset", "2024-01-15T14:30:00+00:00"],
		["minute-precision ISO with timezone offset", "2024-01-15T14:30+00:00"],
	] as const;

	for (const [label, value] of accepted) {
		it(`accepts ${label}`, () => {
			const schema = generateFieldSchema(datetimeField());
			expect(schema.safeParse(value).success).toBe(true);
		});
	}

	const rejected = [
		["naive datetime with seconds", "2026-06-04T18:30:00"],
		["naive datetime without seconds", "2024-01-15T14:30"],
		["date only", "2024-01-15"],
		["non-date text", "not-a-date"],
		["slash-separated date", "2024/01/15"],
		["an impossible date (semantic validation retained)", "2024-13-45T99:99:99"],
	] as const;

	for (const [label, value] of rejected) {
		it(`rejects ${label}`, () => {
			const schema = generateFieldSchema(datetimeField());
			expect(schema.safeParse(value).success).toBe(false);
		});
	}

	it("round-trips null/undefined for an optional datetime field", () => {
		const schema = generateFieldSchema(datetimeField({ required: false }));
		expect(schema.parse(undefined)).toBe(undefined);
		expect(schema.parse(null)).toBe(null);
		expect(schema.safeParse("2026-06-04T18:30:00").success).toBe(false);
	});
});
