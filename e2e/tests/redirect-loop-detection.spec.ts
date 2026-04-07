/**
 * Redirect Loop Detection E2E Tests
 *
 * Tests write-time loop prevention, pattern-aware detection,
 * cache behavior, and admin UI warnings.
 */

import { test, expect } from "../fixtures";

function apiHeaders(token: string, baseUrl: string) {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${token}`,
		"X-EmDash-Request": "1",
		Origin: baseUrl,
	};
}

/** Create a redirect via API, return the id */
async function create(
	page: import("@playwright/test").Page,
	baseUrl: string,
	token: string,
	source: string,
	destination: string,
	options?: { enabled?: boolean },
): Promise<string> {
	const res = await page.request.post(`${baseUrl}/_emdash/api/redirects`, {
		headers: apiHeaders(token, baseUrl),
		data: { source, destination, ...options },
	});
	const body = await res.json();
	if (!res.ok()) {
		return body.error?.message ?? "unknown error";
	}
	return body.data.id;
}

/** Try to create a redirect, expect rejection. Return error message. */
async function createExpectError(
	page: import("@playwright/test").Page,
	baseUrl: string,
	token: string,
	source: string,
	destination: string,
): Promise<string> {
	const res = await page.request.post(`${baseUrl}/_emdash/api/redirects`, {
		headers: apiHeaders(token, baseUrl),
		data: { source, destination },
	});
	expect(res.ok(), `Expected rejection for ${source} → ${destination}`).toBe(false);
	const body = await res.json();
	return body.error?.message ?? "unknown error";
}

/** Try to create a redirect, expect success */
async function createExpectSuccess(
	page: import("@playwright/test").Page,
	baseUrl: string,
	token: string,
	source: string,
	destination: string,
): Promise<void> {
	const res = await page.request.post(`${baseUrl}/_emdash/api/redirects`, {
		headers: apiHeaders(token, baseUrl),
		data: { source, destination },
	});
	const body = await res.json();
	expect(res.ok(), `Expected success for ${source} → ${destination}: ${JSON.stringify(body)}`).toBe(
		true,
	);
}

/** Delete all redirects */
async function cleanup(
	page: import("@playwright/test").Page,
	baseUrl: string,
	token: string,
): Promise<void> {
	const headers = apiHeaders(token, baseUrl);
	const res = await page.request.get(`${baseUrl}/_emdash/api/redirects`, { headers });
	if (!res.ok()) return;
	const data = await res.json();
	for (const item of data.data?.items ?? []) {
		await page.request.delete(`${baseUrl}/_emdash/api/redirects/${item.id}`, { headers });
	}
}

test.describe("redirect loop detection", () => {
	test.beforeEach(async ({ admin, page, serverInfo }) => {
		await admin.devBypassAuth();
		await cleanup(page, serverInfo.baseUrl, serverInfo.token);
	});

	test.afterEach(async ({ page, serverInfo }) => {
		await cleanup(page, serverInfo.baseUrl, serverInfo.token);
	});

	// -----------------------------------------------------------------------
	// Exact redirect loops
	// -----------------------------------------------------------------------

	test("rejects an exact loop", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/one", "/two");
		await createExpectSuccess(page, baseUrl, token, "/two", "/three");
		const msg = await createExpectError(page, baseUrl, token, "/three", "/one");
		expect(msg).toContain("loop");
	});

	test("allows a chain that does not loop", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/a", "/b");
		await createExpectSuccess(page, baseUrl, token, "/b", "/c");
		await createExpectSuccess(page, baseUrl, token, "/c", "/d");
	});

	test("allows unrelated redirects", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/a", "/b");
		await createExpectSuccess(page, baseUrl, token, "/x", "/y");
	});

	test("rejects self-redirect", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		const res = await page.request.post(`${baseUrl}/_emdash/api/redirects`, {
			headers: apiHeaders(token, baseUrl),
			data: { source: "/a", destination: "/a" },
		});
		expect(res.ok()).toBe(false);
	});

	// -----------------------------------------------------------------------
	// Pattern template loops
	// -----------------------------------------------------------------------

	test("rejects matching pattern template loop: [slug]", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/blog/[slug]", "/articles/[slug]");
		const msg = await createExpectError(page, baseUrl, token, "/articles/[slug]", "/blog/[slug]");
		expect(msg).toContain("loop");
	});

	test("rejects matching pattern template loop: [...path]", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/old/[...path]", "/new/[...path]");
		const msg = await createExpectError(page, baseUrl, token, "/new/[...path]", "/old/[...path]");
		expect(msg).toContain("loop");
	});

	test("allows non-looping pattern redirects", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/blog/[slug]", "/articles/[slug]");
		await createExpectSuccess(page, baseUrl, token, "/news/[slug]", "/archive/[slug]");
	});

	// -----------------------------------------------------------------------
	// Pattern + exact mixed loops
	// -----------------------------------------------------------------------

	test("rejects pattern + exact loop", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/blog/[slug]", "/articles/[slug]");
		const msg = await createExpectError(page, baseUrl, token, "/articles/hello", "/blog/hello");
		expect(msg).toContain("loop");
	});

	test("rejects exact + pattern loop (reverse order)", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/articles/hello", "/blog/hello");
		const msg = await createExpectError(page, baseUrl, token, "/blog/[slug]", "/articles/[slug]");
		expect(msg).toContain("loop");
	});

	test("allows pattern + exact that don't overlap", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/blog/[slug]", "/articles/[slug]");
		await createExpectSuccess(page, baseUrl, token, "/news/hello", "/archive/hello");
	});

	// -----------------------------------------------------------------------
	// Catch-all + different pattern loops
	// -----------------------------------------------------------------------

	test("rejects catch-all + [slug] loop", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/old/[...path]", "/new/[...path]");
		const msg = await createExpectError(
			page,
			baseUrl,
			token,
			"/new/archive/[slug]",
			"/old/archive/[slug]",
		);
		expect(msg).toContain("loop");
	});

	test("rejects mixed catch-all and slug 3-way loop", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/old/[...path]", "/new/[...path]");
		await createExpectSuccess(page, baseUrl, token, "/new/docs/[slug]", "/archive/docs/[slug]");
		const msg = await createExpectError(
			page,
			baseUrl,
			token,
			"/archive/[...path]",
			"/old/[...path]",
		);
		expect(msg).toContain("loop");
	});

	test("allows catch-all + non-overlapping pattern", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/old/[...path]", "/new/[...path]");
		await createExpectSuccess(page, baseUrl, token, "/other/[slug]", "/elsewhere/[slug]");
	});

	// -----------------------------------------------------------------------
	// Admin UI warnings
	// -----------------------------------------------------------------------

	test("admin UI shows no loop banner when no loops exist", async ({ admin, page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/one", "/two");
		await createExpectSuccess(page, baseUrl, token, "/two", "/three");

		await admin.goto("/redirects");
		await admin.waitForShell();
		await admin.waitForLoading();

		await expect(page.locator("text=Redirect loop detected")).toBeHidden();
	});

	// -----------------------------------------------------------------------
	// Error message format
	// -----------------------------------------------------------------------

	test("error message shows template names, not __p__ dummy values", async ({
		page,
		serverInfo,
	}) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/blog/[slug]", "/articles/[slug]");
		const msg = await createExpectError(page, baseUrl, token, "/articles/hello", "/blog/hello");
		expect(msg).not.toContain("__p__");
		expect(msg).toContain("/articles/hello");
		expect(msg).toContain("/blog/hello");
	});

	// -----------------------------------------------------------------------
	// Update-time loop detection
	// -----------------------------------------------------------------------

	test("rejects update that would create a loop", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		const headers = apiHeaders(token, baseUrl);
		await createExpectSuccess(page, baseUrl, token, "/a", "/b");
		await createExpectSuccess(page, baseUrl, token, "/b", "/c");
		const id = await create(page, baseUrl, token, "/c", "/d");

		const res = await page.request.put(`${baseUrl}/_emdash/api/redirects/${id}`, {
			headers,
			data: { destination: "/a" },
		});
		expect(res.ok()).toBe(false);
		const body = await res.json();
		expect(body.error?.message).toContain("loop");
	});

	test("allows update that does not create a loop", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		const headers = apiHeaders(token, baseUrl);
		await createExpectSuccess(page, baseUrl, token, "/a", "/b");
		const id = await create(page, baseUrl, token, "/b", "/c");

		const res = await page.request.put(`${baseUrl}/_emdash/api/redirects/${id}`, {
			headers,
			data: { destination: "/d" },
		});
		expect(res.ok()).toBe(true);
	});

	test("rejects update changing source to create a loop", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		const headers = apiHeaders(token, baseUrl);
		await createExpectSuccess(page, baseUrl, token, "/a", "/b");
		await createExpectSuccess(page, baseUrl, token, "/b", "/c");
		const id = await create(page, baseUrl, token, "/x", "/a");

		const res = await page.request.put(`${baseUrl}/_emdash/api/redirects/${id}`, {
			headers,
			data: { source: "/c" },
		});
		expect(res.ok()).toBe(false);
		const body = await res.json();
		expect(body.error?.message).toContain("loop");
	});

	test("rejects update changing both source and destination to create a loop", async ({
		page,
		serverInfo,
	}) => {
		const { baseUrl, token } = serverInfo;
		const headers = apiHeaders(token, baseUrl);
		await createExpectSuccess(page, baseUrl, token, "/a", "/b");
		const id = await create(page, baseUrl, token, "/x", "/y");

		const res = await page.request.put(`${baseUrl}/_emdash/api/redirects/${id}`, {
			headers,
			data: { source: "/b", destination: "/a" },
		});
		expect(res.ok()).toBe(false);
		const body = await res.json();
		expect(body.error?.message).toContain("loop");
	});

	test("rejects update changing destination + enabling simultaneously", async ({
		page,
		serverInfo,
	}) => {
		const { baseUrl, token } = serverInfo;
		const headers = apiHeaders(token, baseUrl);
		await createExpectSuccess(page, baseUrl, token, "/a", "/b");
		const id = await create(page, baseUrl, token, "/b", "/safe", { enabled: false });

		const res = await page.request.put(`${baseUrl}/_emdash/api/redirects/${id}`, {
			headers,
			data: { destination: "/a", enabled: true },
		});
		expect(res.ok()).toBe(false);
		const body = await res.json();
		expect(body.error?.message).toContain("loop");
	});

	// -----------------------------------------------------------------------
	// Edge cases
	// -----------------------------------------------------------------------

	test("allows chain (not loop)", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/a", "/b");
		await createExpectSuccess(page, baseUrl, token, "/b", "/c");
	});

	test("rejects duplicate source", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/a", "/b");
		const res = await page.request.post(`${baseUrl}/_emdash/api/redirects`, {
			headers: apiHeaders(token, baseUrl),
			data: { source: "/a", destination: "/c" },
		});
		expect(res.ok()).toBe(false);
		const body = await res.json();
		expect(body.error?.code).toBe("CONFLICT");
	});

	test("disabled redirect does not participate in loop detection", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		const headers = apiHeaders(token, baseUrl);
		const id = await create(page, baseUrl, token, "/a", "/b");
		await createExpectSuccess(page, baseUrl, token, "/b", "/c");

		await page.request.put(`${baseUrl}/_emdash/api/redirects/${id}`, {
			headers,
			data: { enabled: false },
		});

		await createExpectSuccess(page, baseUrl, token, "/c", "/a");
	});

	test("re-enabling a disabled redirect that creates a loop is allowed", async ({
		page,
		serverInfo,
	}) => {
		// Users who had redirects before upgrade should be able to toggle
		// them freely. The warning banner alerts them to the loop.
		const { baseUrl, token } = serverInfo;
		const headers = apiHeaders(token, baseUrl);
		await createExpectSuccess(page, baseUrl, token, "/a", "/b");
		await createExpectSuccess(page, baseUrl, token, "/b", "/c");
		const id = await create(page, baseUrl, token, "/c", "/a", { enabled: false });

		const res = await page.request.put(`${baseUrl}/_emdash/api/redirects/${id}`, {
			headers,
			data: { enabled: true },
		});
		expect(res.ok()).toBe(true);
	});

	// -----------------------------------------------------------------------
	// Advanced pattern combinations
	// -----------------------------------------------------------------------

	test("rejects catch-all chain loop", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/old/[...path]", "/mid/[...path]");
		await createExpectSuccess(page, baseUrl, token, "/mid/[...path]", "/new/[...path]");
		const msg = await createExpectError(page, baseUrl, token, "/new/[...path]", "/old/[...path]");
		expect(msg).toContain("loop");
	});

	test("rejects exact landing in catch-all scope creating loop", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/old/[...path]", "/new/[...path]");
		await createExpectSuccess(page, baseUrl, token, "/page", "/old/page");
		const msg = await createExpectError(page, baseUrl, token, "/new/page", "/page");
		expect(msg).toContain("loop");
	});

	test("rejects pattern with different param names that still loops", async ({
		page,
		serverInfo,
	}) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/blog/[slug]", "/articles/[slug]");
		const msg = await createExpectError(page, baseUrl, token, "/articles/[id]", "/blog/[id]");
		expect(msg).toContain("loop");
	});

	test("rejects exact redirect into catch-all scope that loops", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/old/[...path]", "/new/[...path]");
		const msg = await createExpectError(page, baseUrl, token, "/new/hello", "/old/hello");
		expect(msg).toContain("loop");
	});

	test("rejects long mixed chain: exact → pattern → exact → pattern → loop", async ({
		page,
		serverInfo,
	}) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/start", "/blog/start");
		await createExpectSuccess(page, baseUrl, token, "/blog/[slug]", "/mid/[slug]");
		await createExpectSuccess(page, baseUrl, token, "/mid/start", "/end/start");
		const msg = await createExpectError(page, baseUrl, token, "/end/start", "/start");
		expect(msg).toContain("loop");
	});

	test("rejects loop through nested catch-all and exact", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/docs/[...path]", "/v2/docs/[...path]");
		const msg = await createExpectError(
			page,
			baseUrl,
			token,
			"/v2/docs/guide/intro",
			"/docs/guide/intro",
		);
		expect(msg).toContain("loop");
	});

	test("rejects catch-all loop even with deep nesting", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/v1/[...path]", "/v2/[...path]");
		const msg = await createExpectError(
			page,
			baseUrl,
			token,
			"/v2/api/users/[slug]",
			"/v1/api/users/[slug]",
		);
		expect(msg).toContain("loop");
	});

	test("rejects 3-way pattern loop with different prefixes", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/en/[slug]", "/fr/[slug]");
		await createExpectSuccess(page, baseUrl, token, "/fr/[slug]", "/de/[slug]");
		const msg = await createExpectError(page, baseUrl, token, "/de/[slug]", "/en/[slug]");
		expect(msg).toContain("loop");
	});

	test("multi-param pattern loop: /blog/[year]/[slug]", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(
			page,
			baseUrl,
			token,
			"/blog/[year]/[slug]",
			"/archive/[year]/[slug]",
		);
		const msg = await createExpectError(
			page,
			baseUrl,
			token,
			"/archive/[year]/[slug]",
			"/blog/[year]/[slug]",
		);
		expect(msg).toContain("loop");
	});

	test("pattern redirect with static destination that loops back", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/blog/[slug]", "/landing");
		const msg = await createExpectError(page, baseUrl, token, "/landing", "/blog/hello");
		expect(msg).toContain("loop");
	});

	test("multiple overlapping catch-alls: more specific loops back", async ({
		page,
		serverInfo,
	}) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/a/[...path]", "/b/[...path]");
		await createExpectSuccess(page, baseUrl, token, "/a/sub/[...path]", "/c/[...path]");
		const msg = await createExpectError(page, baseUrl, token, "/c/[...path]", "/a/sub/[...path]");
		expect(msg).toContain("loop");
	});

	test("disabled pattern in middle of would-be loop allows creation", async ({
		page,
		serverInfo,
	}) => {
		const { baseUrl, token } = serverInfo;
		const headers = apiHeaders(token, baseUrl);
		const id = await create(page, baseUrl, token, "/blog/[slug]", "/articles/[slug]");

		await page.request.put(`${baseUrl}/_emdash/api/redirects/${id}`, {
			headers,
			data: { enabled: false },
		});

		await createExpectSuccess(page, baseUrl, token, "/articles/[slug]", "/blog/[slug]");
	});

	// -----------------------------------------------------------------------
	// False positive prevention
	// -----------------------------------------------------------------------

	test("allows two patterns with overlapping prefix but no loop", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/blog/[slug]", "/articles/[slug]");
		await createExpectSuccess(page, baseUrl, token, "/blog/archive/[slug]", "/old/archive/[slug]");
	});

	test("catch-all + unrelated slug pattern does not false-positive", async ({
		page,
		serverInfo,
	}) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/old/[...path]", "/new/[...path]");
		await createExpectSuccess(page, baseUrl, token, "/other/docs/[slug]", "/archive/docs/[slug]");
	});

	test("two independent catch-alls do not false-positive", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/v1/[...path]", "/v2/[...path]");
		await createExpectSuccess(page, baseUrl, token, "/alpha/[...path]", "/beta/[...path]");
	});

	test("partially overlapping prefixes do not false-positive", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/blog/[slug]", "/articles/[slug]");
		await createExpectSuccess(page, baseUrl, token, "/art/[slug]", "/gallery/[slug]");
	});

	test("pattern redirect with static destination does not false-positive", async ({
		page,
		serverInfo,
	}) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/blog/[slug]", "/landing");
		await createExpectSuccess(page, baseUrl, token, "/landing", "/home");
	});

	test("exact source shadows pattern — no false loop through pattern", async ({
		page,
		serverInfo,
	}) => {
		const { baseUrl, token } = serverInfo;
		await createExpectSuccess(page, baseUrl, token, "/blog/hello", "/archive/hello");
		await createExpectSuccess(page, baseUrl, token, "/blog/[slug]", "/articles/[slug]");
		await createExpectSuccess(page, baseUrl, token, "/articles/hello", "/somewhere");
	});

	// -----------------------------------------------------------------------
	// Long chains (20+)
	// -----------------------------------------------------------------------

	test("rejects loop at the end of a 25-redirect chain", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		for (let i = 1; i <= 24; i++) {
			await createExpectSuccess(page, baseUrl, token, `/r${i}`, `/r${i + 1}`);
		}
		const msg = await createExpectError(page, baseUrl, token, "/r25", "/r1");
		expect(msg).toContain("loop");
		expect(msg).toContain("/r1");
		expect(msg).toContain("/r25");
	});

	test("allows a 25-redirect chain without loop", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		for (let i = 1; i <= 25; i++) {
			await createExpectSuccess(page, baseUrl, token, `/chain${i}`, `/chain${i + 1}`);
		}
	});

	test("rejects loop in a 20+ chain with pattern at the end", async ({ page, serverInfo }) => {
		const { baseUrl, token } = serverInfo;
		for (let i = 1; i <= 19; i++) {
			await createExpectSuccess(page, baseUrl, token, `/p${i}`, `/p${i + 1}`);
		}
		await createExpectSuccess(page, baseUrl, token, "/p20", "/blog/final");
		const msg = await createExpectError(page, baseUrl, token, "/blog/[slug]", "/p1");
		expect(msg).toContain("loop");
	});
});
