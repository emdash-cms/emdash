import type { Kysely as KyselyType } from "kysely";
import { Kysely, SqliteAdapter, SqliteDialect } from "kysely";
import { describe, expect, it } from "vitest";

import { compoundSelectLimit } from "../../../src/database/dialect-helpers.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter probe takes any instance
type AnyDb = KyselyType<any>;

function stockDb(): AnyDb {
	return new Kysely({ dialect: new SqliteDialect({ database: {} as never }) });
}

function dbDeclaring(limit: unknown): AnyDb {
	class DeclaringAdapter extends SqliteAdapter {
		readonly compoundSelectLimit = limit;
	}
	class DeclaringDialect extends SqliteDialect {
		override createAdapter(): SqliteAdapter {
			return new DeclaringAdapter();
		}
	}
	return new Kysely({ dialect: new DeclaringDialect({ database: {} as never }) });
}

describe("compoundSelectLimit", () => {
	it("returns null for an adapter that declares no ceiling", () => {
		expect(compoundSelectLimit(stockDb())).toBeNull();
	});

	it("returns the declared ceiling", () => {
		expect(compoundSelectLimit(dbDeclaring(5))).toBe(5);
		expect(compoundSelectLimit(dbDeclaring(1))).toBe(1);
	});

	it.each([
		["zero", 0],
		["negative", -1],
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
		["fractional", 2.5],
		["a numeric string", "5"],
		["null", null],
	])("throws for a %s ceiling instead of returning it", (_label, limit) => {
		expect(() => compoundSelectLimit(dbDeclaring(limit))).toThrow(
			/compoundSelectLimit.*positive integer/s,
		);
	});

	it("names the offending adapter so the dialect can be found", () => {
		expect(() => compoundSelectLimit(dbDeclaring(0))).toThrow(/DeclaringAdapter/);
	});
});
