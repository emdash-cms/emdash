import { describe, expect, it } from "vitest";

import { isConfirmedStatementFailure } from "../../../../src/database/repositories/content.js";

describe("isConfirmedStatementFailure", () => {
	it("recognizes node:sqlite statement errors", () => {
		expect(isConfirmedStatementFailure({ code: "ERR_SQLITE_ERROR" })).toBe(true);
	});

	it("does not classify non-database errors as confirmed statement failures", () => {
		expect(isConfirmedStatementFailure(new Error("connection interrupted"))).toBe(false);
	});
});
