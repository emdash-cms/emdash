/**
 * Unit tests for the enforcement SQL builders' input guards. The builders are
 * exported and interpolate the caller-supplied row alias into raw SQL, so a
 * malformed alias must be rejected rather than reach the query text.
 */

import { type AcceptedLabelerPolicy } from "@emdash-cms/registry-moderation";
import { describe, expect, it } from "vitest";

import {
	buildPackageEnforcementSql,
	buildReleaseEnforcementSql,
} from "../src/routes/xrpc/label-enforcement.js";

const accepted: AcceptedLabelerPolicy[] = [{ did: "did:web:labels.example", redact: false }];

describe("buildReleaseEnforcementSql alias validation", () => {
	it("rejects an alias that is not an identifier followed by a dot", () => {
		expect(() =>
			buildReleaseEnforcementSql(accepted, 0, { release: "r; DROP TABLE releases;--" }),
		).toThrow(TypeError);
		expect(() => buildReleaseEnforcementSql(accepted, 0, { package: "p" })).toThrow(TypeError);
	});

	it("accepts the default aliases", () => {
		const { sql } = buildReleaseEnforcementSql(accepted, 0);
		expect(sql).toContain("NOT EXISTS");
	});
});

describe("buildPackageEnforcementSql alias validation", () => {
	it("rejects an alias that is not an identifier followed by a dot", () => {
		expect(() => buildPackageEnforcementSql(accepted, 0, "p; DROP TABLE packages;--")).toThrow(
			TypeError,
		);
		expect(() => buildPackageEnforcementSql(accepted, 0, "p")).toThrow(TypeError);
	});

	it("accepts the default alias", () => {
		const { sql } = buildPackageEnforcementSql(accepted, 0);
		expect(sql).toContain("NOT EXISTS");
	});
});
