import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockJwtVerify } = vi.hoisted(() => ({
	mockJwtVerify: vi.fn(),
}));

vi.mock("jose", async (importOriginal) => {
	const actual = await importOriginal<typeof import("jose")>();
	return { ...actual, jwtVerify: mockJwtVerify };
});

import {
	authenticate,
	type AccessConfig,
	resolveRoleFromGroups,
} from "../../src/auth/cloudflare-access.js";

const config: AccessConfig = {
	teamDomain: "example.cloudflareaccess.com",
	roleMapping: { Admins: 50, Editors: 40 },
};

describe("resolveRoleFromGroups", () => {
	it("uses the built-in default role when the identity has no groups", () => {
		expect(resolveRoleFromGroups(undefined, config)).toBe(30);
	});

	it("uses the configured default role when the identity has no groups", () => {
		expect(resolveRoleFromGroups(undefined, { ...config, defaultRole: 10 })).toBe(10);
	});

	it("uses the default role for an empty group list", () => {
		expect(resolveRoleFromGroups([], { ...config, defaultRole: 10 })).toBe(10);
	});

	it("uses the default role when no group matches", () => {
		expect(resolveRoleFromGroups([{ id: "1", name: "Other" }], config)).toBe(30);
	});

	it("uses the first matching group's role", () => {
		expect(
			resolveRoleFromGroups(
				[
					{ id: "1", name: "Other" },
					{ id: "2", name: "Editors" },
					{ id: "3", name: "Admins" },
				],
				config,
			),
		).toBe(40);
	});

	it("matches groups by id when matchGroupsBy is id", () => {
		const byId: AccessConfig = {
			teamDomain: config.teamDomain,
			roleMapping: { "id-admins": 50 },
			matchGroupsBy: "id",
		};
		expect(resolveRoleFromGroups([{ id: "id-admins", name: "Admins" }], byId)).toBe(50);
	});

	it("does not match a group whose name equals an id key when matchGroupsBy is id", () => {
		expect(
			resolveRoleFromGroups([{ id: "id-other", name: "id-admins" }], {
				teamDomain: config.teamDomain,
				roleMapping: { "id-admins": 50 },
				matchGroupsBy: "id",
			}),
		).toBe(30);
	});

	it("does not match group names when matchGroupsBy is id", () => {
		expect(
			resolveRoleFromGroups([{ id: "id-other", name: "Admins" }], {
				...config,
				matchGroupsBy: "id",
			}),
		).toBe(30);
	});

	it("uses the default role when no role mapping is configured", () => {
		expect(
			resolveRoleFromGroups(undefined, {
				teamDomain: config.teamDomain,
				defaultRole: 10,
			}),
		).toBe(10);
	});
});

describe("authenticate", () => {
	beforeEach(() => {
		mockJwtVerify.mockResolvedValue({
			payload: { sub: "github-user", email: "user@example.com" },
		});
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	const authenticateWithIdentity = async (
		identity: Record<string, unknown>,
		accessConfig: AccessConfig,
	) => {
		vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(identity), { status: 200 }));

		return authenticate(
			new Request("https://example.com", {
				headers: { "Cf-Access-Jwt-Assertion": "test-jwt" },
			}),
			accessConfig,
		);
	};

	const githubIdentity = (extra: Record<string, unknown> = {}) => ({
		id: "github-user",
		email: "user@example.com",
		idp: { id: "github", type: "github" },
		orgs: [{ id: 1, name: "my-org" }],
		...extra,
	});

	it.each<{
		name: string;
		identity: Record<string, unknown>;
		mapping: Record<string, number> | undefined;
		matchGroupsBy?: AccessConfig["matchGroupsBy"];
		expected: number;
	}>([
		{
			name: "matches the first GitHub team",
			identity: githubIdentity({
				orgs: [{ id: 1, name: "my-org" }],
				teams: [
					{ name: "Web Admins", org_id: 1 },
					{ name: "Knowledge Stewardship", org_id: 1 },
				],
			}),
			mapping: { "my-org/Web Admins": 50, "my-org/Knowledge Stewardship": 40 },
			expected: 50,
		},
		{
			name: "uses the first matching GitHub team rather than the highest role",
			identity: githubIdentity({
				teams: [
					{ name: "Knowledge Stewardship", org_id: 1 },
					{ name: "Web Admins", org_id: 1 },
				],
			}),
			mapping: { "my-org/Web Admins": 50, "my-org/Knowledge Stewardship": 40 },
			expected: 40,
		},
		{
			name: "uses the default when there are no teams or groups",
			identity: githubIdentity(),
			mapping: { "my-org/Web Admins": 50 },
			expected: 20,
		},
		{
			name: "uses the default for empty teams",
			identity: githubIdentity({ teams: [] }),
			mapping: { "my-org/Web Admins": 50 },
			expected: 20,
		},
		{
			name: "uses the default for unmatched teams",
			identity: githubIdentity({ teams: [{ name: "Other", org_id: 1 }] }),
			mapping: { "my-org/Web Admins": 50 },
			expected: 20,
		},
		{
			name: "keeps groups-only identities working",
			identity: githubIdentity({ groups: [{ id: "1", name: "Admins" }] }),
			mapping: { Admins: 50 },
			expected: 50,
		},
		{
			name: "gives matching groups precedence over teams",
			identity: githubIdentity({
				groups: [{ id: "1", name: "Editors" }],
				teams: [{ name: "Web Admins", org_id: 1 }],
			}),
			mapping: { Editors: 40, "my-org/Web Admins": 50 },
			expected: 40,
		},
		{
			name: "uses a team when groups do not match",
			identity: githubIdentity({
				groups: [{ id: "1", name: "Other" }],
				teams: [{ name: "Web Admins", org_id: 1 }],
			}),
			mapping: { "my-org/Web Admins": 50 },
			expected: 50,
		},
		{
			name: "uses the default without a mapping",
			identity: githubIdentity({ teams: [{ name: "Web Admins", org_id: 1 }] }),
			mapping: undefined,
			expected: 20,
		},
		{
			name: "does not match a team in another organization",
			identity: githubIdentity({
				orgs: [
					{ id: 1, name: "my-org" },
					{ id: 2, name: "other-org" },
				],
				teams: [{ name: "Web Admins", org_id: 2 }],
			}),
			mapping: { "my-org/Web Admins": 50 },
			expected: 20,
		},
		{
			name: "does not match a team with an unknown organization ID",
			identity: githubIdentity({ teams: [{ name: "Web Admins", org_id: 2 }] }),
			mapping: { "my-org/Web Admins": 50 },
			expected: 20,
		},
		{
			name: "does not match teams when organizations are omitted",
			identity: githubIdentity({ orgs: undefined, teams: [{ name: "Web Admins", org_id: 1 }] }),
			mapping: { "my-org/Web Admins": 50 },
			expected: 20,
		},
		{
			name: "does not match bare team names",
			identity: githubIdentity({ teams: [{ name: "Web Admins", org_id: 1 }] }),
			mapping: { "Web Admins": 50 },
			expected: 20,
		},
		{
			name: "does not map organization names",
			identity: githubIdentity({ orgs: [{ id: 1, name: "Web Admins" }] }),
			mapping: { "Web Admins": 50 },
			expected: 20,
		},
		{
			name: "matches a group by id when matchGroupsBy is id",
			identity: githubIdentity({ groups: [{ id: "group-1", name: "Admins" }] }),
			mapping: { "group-1": 50 },
			matchGroupsBy: "id",
			expected: 50,
		},
		{
			name: "ignores a same-named group with another id when matchGroupsBy is id",
			identity: githubIdentity({
				groups: [
					{ id: "group-2", name: "Admins" },
					{ id: "group-3", name: "group-1" },
				],
			}),
			mapping: { "group-1": 50, Admins: 50 },
			matchGroupsBy: "id",
			expected: 20,
		},
		{
			name: "still matches GitHub teams when matchGroupsBy is id",
			identity: githubIdentity({ teams: [{ name: "Web Admins", org_id: 1 }] }),
			mapping: { "my-org/Web Admins": 50 },
			matchGroupsBy: "id",
			expected: 50,
		},
	])("$name", async ({ identity, mapping, matchGroupsBy, expected }) => {
		const result = await authenticateWithIdentity(identity, {
			teamDomain: "example.cloudflareaccess.com",
			audience: "test-audience",
			defaultRole: 20,
			roleMapping: mapping,
			matchGroupsBy,
		});

		expect(result.role).toBe(expected);
	});
});
