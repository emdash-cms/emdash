import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";

import { GET } from "../../../src/astro/routes/api/import/wordpress-plugin/callback.js";

const CALLBACK = "https://site.test/_emdash/api/import/wordpress-plugin/callback";
const CREDENTIALS = "site_url=https%3A%2F%2Fwp.test&user_login=admin&password=app-password";
const STATE_COOKIE = "emdash_wp_auth_state";

async function callback(query: string, stateCookie?: string, role: number = Role.ADMIN) {
	const set: string[] = [];
	const deleted: string[] = [];
	const response = await GET({
		url: new URL(`${CALLBACK}?${query}`),
		locals: { user: { id: "user-1", role } },
		cookies: {
			get: (name: string) =>
				name === STATE_COOKIE && stateCookie ? { value: stateCookie } : undefined,
			set: (name: string) => set.push(name),
			delete: (name: string) => deleted.push(name),
		},
		redirect: (location: string) =>
			new Response(null, { status: 302, headers: { Location: location } }),
	} as unknown as APIContext);
	return { response, set, deleted };
}

describe("WordPress application password callback", () => {
	it("hands the credentials to the wizard when this browser started the authorization", async () => {
		const { response, set, deleted } = await callback(`state=abc&${CREDENTIALS}`, "abc");

		expect(response.headers.get("Location")).toBe("/_emdash/admin/import/wordpress?auth=success");
		expect(set).toEqual(["emdash_wp_auth"]);
		expect(deleted).toEqual([STATE_COOKIE]);
	});

	it.each([
		["no state and no cookie", CREDENTIALS, undefined],
		["a state but no cookie", `state=abc&${CREDENTIALS}`, undefined],
		["a cookie but no state", CREDENTIALS, "abc"],
		["a state that differs from the cookie", `state=abc&${CREDENTIALS}`, "xyz"],
	])("refuses a callback with %s", async (_name, query, stateCookie) => {
		const { response, set, deleted } = await callback(query, stateCookie);

		expect(response.headers.get("Location")).toBe(
			"/_emdash/admin/import/wordpress?error=auth_rejected",
		);
		expect(set).toEqual([]);
		expect(deleted).toEqual([STATE_COOKIE]);
	});

	it("requires import:execute", async () => {
		const { response, set } = await callback(`state=abc&${CREDENTIALS}`, "abc", Role.EDITOR);

		expect(response.status).toBe(403);
		expect(set).toEqual([]);
	});
});
