/**
 * Regression tests for issue #1368: a `datetime` field could not round-trip
 * through its own admin editor. The validator was
 * `z.string().datetime().or(z.string().date())`, which only accepts ISO with a
 * `Z` suffix or a bare `YYYY-MM-DD` date. But `<input type="datetime-local">`
 * (and many seeds) produce a *naive* datetime (`YYYY-MM-DDTHH:mm[:ss]`, no
 * offset). Since the admin re-sends every loaded field on autosave, a stored
 * naive datetime failed validation and the entry became unsavable. Same class
 * of autosave-round-trip bug as #867.
 *
 * The fix validates with `z.iso.datetime({ offset: true, local: true })` (which
 * accepts `Z`, timezone offsets, and naive datetimes) unioned with
 * `z.iso.date()` for date-only values — while still rejecting garbage and
 * impossible dates.
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
		["ISO with timezone offset", "2024-01-15T14:30:00+00:00"],
		["naive datetime with seconds (seeded value -- the bug)", "2026-06-04T18:30:00"],
		["naive datetime without seconds (datetime-local default)", "2024-01-15T14:30"],
		["date only", "2024-01-15"],
	] as const;

	for (const [label, value] of accepted) {
		it(`accepts ${label}`, () => {
			const schema = generateFieldSchema(datetimeField());
			expect(schema.safeParse(value).success).toBe(true);
		});
	}

	const rejected = [
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
		expect(schema.safeParse("2026-06-04T18:30:00").success).toBe(true);
	});
});
