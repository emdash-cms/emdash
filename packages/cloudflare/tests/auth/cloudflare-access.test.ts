import { describe, expect, it } from "vitest";

import { type AccessConfig, resolveRoleFromGroups } from "../../src/auth/cloudflare-access.js";

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

	it("uses the default role when no role mapping is configured", () => {
		expect(
			resolveRoleFromGroups(undefined, {
				teamDomain: config.teamDomain,
				defaultRole: 10,
			}),
		).toBe(10);
	});
});
