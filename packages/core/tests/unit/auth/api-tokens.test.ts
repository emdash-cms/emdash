/**
 * Unit tests for API token generation, hashing, and scope utilities.
 */

import { Role, scopesForRole, clampScopes } from "@emdash-cms/auth";
import { describe, it, expect } from "vitest";

import {
	generatePrefixedToken,
	hashApiToken,
	validateScopes,
	hasScope,
	TOKEN_PREFIXES,
	VALID_SCOPES,
} from "../../../src/auth/api-tokens.js";

// Regex patterns for token validation
const PAT_PREFIX_REGEX = /^ec_pat_/;
const OAUTH_ACCESS_PREFIX_REGEX = /^ec_oat_/;
const OAUTH_REFRESH_PREFIX_REGEX = /^ec_ort_/;
const BASE64URL_INVALID_CHARS_REGEX = /[+/=]/;
const BASE64URL_VALID_REGEX = /^[A-Za-z0-9_-]+$/;

describe("generatePrefixedToken", () => {
	it("generates a PAT with ec_pat_ prefix", () => {
		const { raw, hash, prefix } = generatePrefixedToken(TOKEN_PREFIXES.PAT);

		expect(raw).toMatch(PAT_PREFIX_REGEX);
		expect(raw.length).toBeGreaterThan(20);
		expect(hash).toBeTruthy();
		expect(hash).not.toBe(raw);
		expect(prefix).toMatch(PAT_PREFIX_REGEX);
		expect(prefix.length).toBe(TOKEN_PREFIXES.PAT.length + 4);
	});

	it("generates an OAuth access token with ec_oat_ prefix", () => {
		const { raw } = generatePrefixedToken(TOKEN_PREFIXES.OAUTH_ACCESS);
		expect(raw).toMatch(OAUTH_ACCESS_PREFIX_REGEX);
	});

	it("generates an OAuth refresh token with ec_ort_ prefix", () => {
		const { raw } = generatePrefixedToken(TOKEN_PREFIXES.OAUTH_REFRESH);
		expect(raw).toMatch(OAUTH_REFRESH_PREFIX_REGEX);
	});

	it("generates unique tokens each time", () => {
		const tokens = new Set<string>();
		for (let i = 0; i < 50; i++) {
			const { raw } = generatePrefixedToken("ec_pat_");
			tokens.add(raw);
		}
		expect(tokens.size).toBe(50);
	});

	it("generates unique hashes for different tokens", () => {
		const { hash: hash1 } = generatePrefixedToken("ec_pat_");
		const { hash: hash2 } = generatePrefixedToken("ec_pat_");
		expect(hash1).not.toBe(hash2);
	});
});

describe("hashApiToken", () => {
	it("produces a deterministic hash", () => {
		const hash1 = hashApiToken("ec_pat_abc123");
		const hash2 = hashApiToken("ec_pat_abc123");
		expect(hash1).toBe(hash2);
	});

	it("produces different hashes for different tokens", () => {
		const hash1 = hashApiToken("ec_pat_abc123");
		const hash2 = hashApiToken("ec_pat_def456");
		expect(hash1).not.toBe(hash2);
	});

	it("hashes the full prefixed token", () => {
		// Same suffix but different prefix should produce different hashes
		const hash1 = hashApiToken("ec_pat_abc123");
		const hash2 = hashApiToken("ec_oat_abc123");
		expect(hash1).not.toBe(hash2);
	});

	it("produces URL-safe base64 output", () => {
		const hash = hashApiToken("ec_pat_test");
		// Should not contain +, /, or = (standard base64 chars)
		expect(hash).not.toMatch(BASE64URL_INVALID_CHARS_REGEX);
		// Should only contain base64url chars
		expect(hash).toMatch(BASE64URL_VALID_REGEX);
	});
});

describe("validateScopes", () => {
	it("accepts broad and plugin-specific MCP tool scopes", () => {
		expect(validateScopes(["mcp:tools", "mcp:tools:calendar-plugin"])).toEqual([]);
		expect(
			validateScopes([
				"mcp:tools:",
				"mcp:tools:@acme/calendar",
				"mcp:tools:Calendar",
				"mcp:tools:-calendar",
			]),
		).toEqual([
			"mcp:tools:",
			"mcp:tools:@acme/calendar",
			"mcp:tools:Calendar",
			"mcp:tools:-calendar",
		]);
	});
	it("returns empty array for valid scopes", () => {
		const invalid = validateScopes(["content:read", "media:write"]);
		expect(invalid).toEqual([]);
	});

	it("returns invalid scopes", () => {
		const invalid = validateScopes(["content:read", "invalid:scope", "admin"]);
		expect(invalid).toEqual(["invalid:scope"]);
	});

	it("handles empty array", () => {
		expect(validateScopes([])).toEqual([]);
	});

	it("accepts all valid scopes", () => {
		const invalid = validateScopes([...VALID_SCOPES]);
		expect(invalid).toEqual([]);
	});
});

describe("hasScope", () => {
	it("keeps plugin MCP scopes independent from admin", () => {
		expect(hasScope(["admin"], "mcp:tools:calendar")).toBe(false);
		expect(hasScope(["mcp:tools"], "mcp:tools:calendar")).toBe(true);
		expect(hasScope(["mcp:tools:calendar"], "mcp:tools:calendar")).toBe(true);
		expect(hasScope(["mcp:tools:forms"], "mcp:tools:calendar")).toBe(false);
	});
	it("returns true when scope is present", () => {
		expect(hasScope(["content:read", "media:write"], "content:read")).toBe(true);
	});

	it("returns false when scope is missing", () => {
		expect(hasScope(["content:read"], "content:write")).toBe(false);
	});

	it("admin scope grants access to everything", () => {
		expect(hasScope(["admin"], "content:read")).toBe(true);
		expect(hasScope(["admin"], "schema:write")).toBe(true);
		expect(hasScope(["admin"], "media:write")).toBe(true);
	});

	it("handles empty scopes", () => {
		expect(hasScope([], "content:read")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// scopesForRole — maps roles to maximum allowed scopes
// ---------------------------------------------------------------------------

describe("scopesForRole", () => {
	it("SUBSCRIBER gets only read scopes for content and media", () => {
		const scopes = scopesForRole(Role.SUBSCRIBER);
		expect(scopes).toContain("content:read");
		expect(scopes).toContain("media:read");
		expect(scopes).not.toContain("content:write");
		expect(scopes).not.toContain("media:write");
		expect(scopes).not.toContain("schema:read");
		expect(scopes).not.toContain("schema:write");
		expect(scopes).not.toContain("admin");
	});

	it("CONTRIBUTOR gets content and media read/write", () => {
		const scopes = scopesForRole(Role.CONTRIBUTOR);
		expect(scopes).toContain("content:read");
		expect(scopes).toContain("content:write");
		expect(scopes).toContain("media:read");
		expect(scopes).toContain("media:write");
		expect(scopes).not.toContain("schema:read");
		expect(scopes).not.toContain("schema:write");
		expect(scopes).not.toContain("admin");
	});

	it("EDITOR gets content, media, and schema:read", () => {
		const scopes = scopesForRole(Role.EDITOR);
		expect(scopes).toContain("content:read");
		expect(scopes).toContain("content:write");
		expect(scopes).toContain("media:read");
		expect(scopes).toContain("media:write");
		expect(scopes).toContain("schema:read");
		expect(scopes).not.toContain("schema:write");
		expect(scopes).not.toContain("admin");
	});

	it("ADMIN gets all scopes including admin and schema:write", () => {
		const scopes = scopesForRole(Role.ADMIN);
		expect(scopes).toContain("content:read");
		expect(scopes).toContain("content:write");
		expect(scopes).toContain("media:read");
		expect(scopes).toContain("media:write");
		expect(scopes).toContain("schema:read");
		expect(scopes).toContain("schema:write");
		expect(scopes).toContain("admin");
	});
});

// ---------------------------------------------------------------------------
// clampScopes — intersects requested scopes with role-allowed scopes
// ---------------------------------------------------------------------------

describe("clampScopes", () => {
	it("strips admin scope from non-admin role", () => {
		const result = clampScopes(["content:read", "admin"], Role.CONTRIBUTOR);
		expect(result).toEqual(["content:read"]);
	});

	it("strips schema:write from editor role", () => {
		const result = clampScopes(["schema:read", "schema:write"], Role.EDITOR);
		expect(result).toEqual(["schema:read"]);
	});

	it("preserves all scopes for admin role", () => {
		const all = [
			"content:read",
			"content:write",
			"media:read",
			"media:write",
			"schema:read",
			"schema:write",
			"admin",
		];
		const result = clampScopes(all, Role.ADMIN);
		expect(result).toEqual(all);
	});

	it("returns empty array when no scopes survive clamping", () => {
		const result = clampScopes(["admin", "schema:write"], Role.SUBSCRIBER);
		expect(result).toEqual([]);
	});

	it("handles empty input", () => {
		expect(clampScopes([], Role.ADMIN)).toEqual([]);
	});

	it("strips schema:read from contributor role", () => {
		const result = clampScopes(["content:read", "schema:read"], Role.CONTRIBUTOR);
		expect(result).toEqual(["content:read"]);
	});
});
