import { expect, test } from "../fixtures";

const EMPTY_PRE_NEXT_STATE = JSON.stringify({
	emdash: false,
	user: false,
	requestContext: false,
});

test.describe("outer user middleware", () => {
	test("returns a cached response before EmDash runtime and database initialization", async ({
		serverInfo,
	}) => {
		const response = await fetch(`${serverInfo.baseUrl}/outer-cache-hit`);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("cached before EmDash initialization");
		expect(response.headers.get("x-outer-request-path")).toBe("/outer-cache-hit");
		expect(response.headers.get("x-outer-pre-next-state")).toBe(EMPTY_PRE_NEXT_STATE);
		expect(response.headers.get("server-timing")).toBeNull();
		expect(response.headers.get("x-content-type-options")).toBeNull();
	});

	test("finalizes the fully EmDash-mutated response after next", async ({ serverInfo }) => {
		const response = await fetch(serverInfo.baseUrl, {
			headers: {
				Cookie: serverInfo.sessionCookie,
				"X-Outer-Finalize": "1",
			},
		});
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("x-outer-pre-next-state")).toBe(EMPTY_PRE_NEXT_STATE);
		expect(response.headers.get("x-outer-saw-toolbar")).toBe("true");
		expect(response.headers.get("server-timing")).toContain("render");
		expect(response.headers.get("content-security-policy")).toBe(
			"script-src 'nonce-outer-finalizer'",
		);
		expect(response.headers.get("content-length")).toBe(
			String(new TextEncoder().encode(html).byteLength),
		);
		expect(html).toContain('id="emdash-toolbar"');
		expect(html).toContain('<script nonce="outer-finalizer">');
	});
});
