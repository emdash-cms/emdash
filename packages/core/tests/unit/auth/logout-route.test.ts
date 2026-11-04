import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";

import { POST as postLogout } from "../../../src/astro/routes/api/auth/logout.js";

function makeContext(search: string): Parameters<typeof postLogout>[0] {
	return {
		session: { destroy: () => {} },
		url: new URL(`http://site.example/_emdash/api/auth/logout${search}`),
	} as unknown as APIContext;
}

describe("POST /_emdash/api/auth/logout redirect", () => {
	it("redirects to a same-site path", async () => {
		const response = await postLogout(makeContext("?redirect=/blog"));
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/blog");
	});

	// Browsers strip tab/CR/LF while parsing, so `/\t/evil.example` resolves to `//evil.example`.
	it.each(["%09", "%0A", "%0D"])("ignores a redirect with %s between slashes", async (control) => {
		const response = await postLogout(makeContext(`?redirect=/${control}/evil.example`));
		expect(response.status).toBe(200);
		expect(response.headers.get("Location")).toBeNull();
	});
});
