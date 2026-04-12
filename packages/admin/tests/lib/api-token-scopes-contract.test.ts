import { describe, expect, it } from "vitest";

// Import source (not package `dist`) so the contract tracks edits without a prior `auth` build.
import { VALID_SCOPES } from "../../../auth/src/tokens.js";
import { API_TOKEN_SCOPE_FORM_SCOPES } from "../../src/components/settings/ApiTokenSettings.js";
import { API_TOKEN_SCOPES } from "../../src/lib/api/api-tokens.js";

function sortedUnique(values: readonly string[]): string[] {
	return [...new Set(values)].toSorted((a, b) => a.localeCompare(b));
}

describe("API token scope drift guard", () => {
	it("admin wire constants match server VALID_SCOPES", () => {
		expect(sortedUnique(Object.values(API_TOKEN_SCOPES))).toEqual(sortedUnique(VALID_SCOPES));
	});

	it("create-token UI lists the same scopes as API_TOKEN_SCOPES", () => {
		expect(sortedUnique(API_TOKEN_SCOPE_FORM_SCOPES)).toEqual(
			sortedUnique(Object.values(API_TOKEN_SCOPES)),
		);
	});
});
