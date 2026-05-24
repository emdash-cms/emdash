/**
 * Search E2E Tests
 *
 * Tests the search functionality via:
 * 1. The AdminCommandPalette (Cmd+K) which provides UI-driven content search
 * 2. Direct API calls to the search endpoints
 *
 * Search must be enabled per-collection before it returns content results.
 * The fixture does not enable search by default, so tests enable it first.
 *
 * Seed data:
 *   - posts: "First Post" (published), "Second Post" (published),
 *            "Draft Post" (draft), "Post With Image" (published)
 *   - pages: "About" (published), "Contact" (draft)
 */

import { test, expect } from "../fixtures";

// Regex patterns (module scope per lint rules)
const MEDIA_URL_PATTERN = /\/media/;
const CONTENT_POSTS_URL_PATTERN = /\/content\/posts\//;

// Keyboard modifier for Cmd (Mac) / Ctrl (Linux/Windows)
const MOD_KEY = process.platform === "darwin" ? "Meta" : "Control";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Make an authenticated API request to the test server.
 */
async function apiRequest(
	serverInfo: { baseUrl: string; token: string },
	method: string,
	path: string,
	body?: unknown,
): Promise<Response> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${serverInfo.token}`,
		"X-EmDash-Request": "1",
		Origin: serverInfo.baseUrl,
	};
	if (body !== undefined) {
		headers["Content-Type"] = "application/json";
	}
	return fetch(`${serverInfo.baseUrl}${path}`, {
		method,
		headers,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
}

/**
 * Enable search for a collection, silently ignoring if already enabled.
 */
/**
 * Mark a field as searchable via the schema API.
 * The auto-seed creates collections without the seed.json's searchable flags,
 * so we need to set them via API before enabling FTS.
 */
async function markFieldSearchable(
	serverInfo: { baseUrl: string; token: string },
	collection: string,
	fieldSlug: string,
): Promise<void> {
	await apiRequest(
		serverInfo,
		"PUT",
		`/_emdash/api/schema/collections/${collection}/fields/${fieldSlug}`,
		{ searchable: true },
	);
}

async function enableSearch(
	serverInfo: { baseUrl: string; token: string },
	collection: string,
): Promise<void> {
	// Ensure at least one field is searchable before enabling FTS
	await markFieldSearchable(serverInfo, collection, "title");

	const res = await apiRequest(serverInfo, "POST", "/_emdash/api/search/enable", {
		collection,
		enabled: true,
	});
	// Accept both 200 (success) and 400/409 (already enabled or no searchable fields)
	if (!res.ok && res.status !== 400 && res.status !== 409) {
		const text = await res.text().catch(() => "");
		throw new Error(`Failed to enable search for ${collection} (${res.status}): ${text}`);
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Search", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test.describe("Command Palette", () => {
		test("opens with Cmd+K keyboard shortcut", async ({ admin, page }) => {
			await admin.goToDashboard();

			// Press Cmd+K to open the command palette
			await page.keyboard.press(`${MOD_KEY}+k`);

			// The command palette should be visible with a search input
			const input = page.getByPlaceholder("Search pages and content...");
			await expect(input).toBeVisible({ timeout: 5000 });
		});

		test("closes with Escape", async ({ admin, page }) => {
			await admin.goToDashboard();

			// Open command palette
			await page.keyboard.press(`${MOD_KEY}+k`);
			const input = page.getByPlaceholder("Search pages and content...");
			await expect(input).toBeVisible({ timeout: 5000 });

			// Close with Escape
			await page.keyboard.press("Escape");
			await expect(input).not.toBeVisible({ timeout: 3000 });
		});

		test("shows navigation items by default", async ({ admin, page }) => {
			await admin.goToDashboard();

			await page.keyboard.press(`${MOD_KEY}+k`);
			const input = page.getByPlaceholder("Search pages and content...");
			await expect(input).toBeVisible({ timeout: 5000 });

			// The command palette dialog should show navigation items
			const dialog = page.locator('[role="dialog"]');
			await expect(dialog.getByText("Dashboard")).toBeVisible({ timeout: 5000 });
			await expect(dialog.getByText("Media")).toBeVisible();
		});

		test("filters navigation items when typing", async ({ admin, page }) => {
			await admin.goToDashboard();

			await page.keyboard.press(`${MOD_KEY}+k`);
			const input = page.getByPlaceholder("Search pages and content...");
			await expect(input).toBeVisible({ timeout: 5000 });

			// Type a query that matches "Settings"
			await input.fill("sett");

			// Settings should still be visible, but Dashboard should be filtered out
			await expect(page.getByText("Settings")).toBeVisible({ timeout: 5000 });
		});

		test("shows empty state for no matches", async ({ admin, page }) => {
			await admin.goToDashboard();

			await page.keyboard.press(`${MOD_KEY}+k`);
			const input = page.getByPlaceholder("Search pages and content...");
			await expect(input).toBeVisible({ timeout: 5000 });

			// Type something that won't match any nav or content
			await input.fill("zzzznonexistentxyzzy");

			// Should show "No results found" eventually (after debounce + API response)
			await expect(page.getByText("No results found")).toBeVisible({ timeout: 10000 });
		});

		test("navigates to a page when selecting a nav item", async ({ admin, page }) => {
			await admin.goToDashboard();

			await page.keyboard.press(`${MOD_KEY}+k`);
			const input = page.getByPlaceholder("Search pages and content...");
			await expect(input).toBeVisible({ timeout: 5000 });

			// Type "media" to filter
			await input.fill("media");

			// Click on the Media Library result
			const mediaItem = page.getByText("Media Library");
			await expect(mediaItem).toBeVisible({ timeout: 5000 });
			await mediaItem.click();

			// Should navigate to the media page
			await expect(page).toHaveURL(MEDIA_URL_PATTERN, { timeout: 10000 });
		});
	});

	test.describe("Search API", () => {
		test("search endpoint is publicly accessible", async ({ serverInfo }) => {
			// The LiveSearch component is shipped for public-site use and calls this
			// endpoint without credentials. The query layer hardcodes status='published',
			// so anonymous callers can only see published content.
			const res = await fetch(`${serverInfo.baseUrl}/_emdash/api/search?q=test`);
			expect(res.status).toBe(200);
		});

		test("search admin endpoints still require authentication", async ({ serverInfo }) => {
			// Admin-only: enable, rebuild, stats must stay gated even though the
			// read endpoint is public.
			const stats = await fetch(`${serverInfo.baseUrl}/_emdash/api/search/stats`);
			expect([401, 403]).toContain(stats.status);

			const enable = await fetch(`${serverInfo.baseUrl}/_emdash/api/search/enable`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ collection: "posts" }),
			});
			expect([401, 403]).toContain(enable.status);
		});

		test("search endpoint requires a query parameter", async ({ serverInfo }) => {
			const res = await apiRequest(serverInfo, "GET", "/_emdash/api/search");
			// Missing required `q` param should fail validation
			expect(res.status).toBe(400);
		});

		test("search returns results after enabling search", async ({ serverInfo }) => {
			// Enable search for posts
			await enableSearch(serverInfo, "posts");

			// Rebuild the index so seeded content is indexed
			await apiRequest(serverInfo, "POST", "/_emdash/api/search/rebuild", {
				collection: "posts",
			});

			// Search for "First" -- should match "First Post"
			const res = await apiRequest(serverInfo, "GET", "/_emdash/api/search?q=First&limit=10");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.data).toBeDefined();
			expect(body.data.items).toBeInstanceOf(Array);

			// Should find at least the "First Post"
			const titles = body.data.items.map((item: any) => item.title);
			expect(titles).toContain("First Post");
		});

		test("search filters by collection", async ({ serverInfo }) => {
			// Ensure search is enabled for posts
			await enableSearch(serverInfo, "posts");

			// Search only in posts
			const res = await apiRequest(
				serverInfo,
				"GET",
				"/_emdash/api/search?q=Post&collections=posts&limit=20",
			);
			expect(res.status).toBe(200);

			const body = await res.json();
			const items = body.data.items;

			// All results should be from the posts collection
			for (const item of items) {
				expect(item.collection).toBe("posts");
			}
		});

		test("search returns empty for non-matching query", async ({ serverInfo }) => {
			await enableSearch(serverInfo, "posts");

			const res = await apiRequest(
				serverInfo,
				"GET",
				"/_emdash/api/search?q=zzzznonexistentxyzzy&limit=10",
			);
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.data.items).toHaveLength(0);
		});

		test("search respects limit parameter", async ({ serverInfo }) => {
			await enableSearch(serverInfo, "posts");

			const res = await apiRequest(serverInfo, "GET", "/_emdash/api/search?q=Post&limit=2");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.data.items.length).toBeLessThanOrEqual(2);
		});
	});

	test.describe("Search Suggestions API", () => {
		test.fixme("returns suggestions for partial queries", async ({ serverInfo }) => {
			// TODO: getSuggestions fails in dev mode -- needs investigation
			await enableSearch(serverInfo, "posts");

			const res = await apiRequest(serverInfo, "GET", "/_emdash/api/search/suggest?q=Fir&limit=5");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.data).toBeDefined();
			expect(body.data.items).toBeInstanceOf(Array);
		});

		test("suggestions require a query parameter", async ({ serverInfo }) => {
			const res = await apiRequest(serverInfo, "GET", "/_emdash/api/search/suggest");
			expect(res.status).toBe(400);
		});
	});

	test.describe("Search Stats API", () => {
		test("returns search index statistics", async ({ serverInfo }) => {
			await enableSearch(serverInfo, "posts");

			const res = await apiRequest(serverInfo, "GET", "/_emdash/api/search/stats");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.data).toBeDefined();
		});
	});

	test.describe("Search Enable/Disable API", () => {
		test("enables search for a collection", async ({ serverInfo }) => {
			const res = await apiRequest(serverInfo, "POST", "/_emdash/api/search/enable", {
				collection: "pages",
				enabled: true,
			});
			// May succeed (200) or fail if already enabled or no searchable fields
			// Either way it should not be a 500
			expect(res.status).toBeLessThan(500);
		});

		test("disables search for a collection", async ({ serverInfo }) => {
			// First ensure it's enabled
			await enableSearch(serverInfo, "pages");

			const res = await apiRequest(serverInfo, "POST", "/_emdash/api/search/enable", {
				collection: "pages",
				enabled: false,
			});
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.data.enabled).toBe(false);
		});

		test("enable requires collection name", async ({ serverInfo }) => {
			const res = await apiRequest(serverInfo, "POST", "/_emdash/api/search/enable", {
				enabled: true,
			});
			expect(res.status).toBe(400);
		});
	});

	test.describe("Search Rebuild API", () => {
		test("rebuilds the index for a collection", async ({ serverInfo }) => {
			await enableSearch(serverInfo, "posts");

			const res = await apiRequest(serverInfo, "POST", "/_emdash/api/search/rebuild", {
				collection: "posts",
			});
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(typeof body.data.indexed).toBe("number");
		});

		test("rebuild fails for collection without search enabled", async ({ serverInfo }) => {
			// Disable search for pages first to ensure it's off
			await apiRequest(serverInfo, "POST", "/_emdash/api/search/enable", {
				collection: "pages",
				enabled: false,
			});

			const res = await apiRequest(serverInfo, "POST", "/_emdash/api/search/rebuild", {
				collection: "pages",
			});
			expect(res.status).toBe(400);

			const body = await res.json();
			expect(body.error).toBeDefined();
		});
	});

	test.describe("Command Palette Content Search", () => {
		test.fixme("shows content results when searching with enabled collections", async ({
			// TODO: Command palette content search depends on suggest API which fails in dev
			admin,
			page,
			serverInfo,
		}) => {
			// Enable search and rebuild index so content is findable
			await enableSearch(serverInfo, "posts");
			await apiRequest(serverInfo, "POST", "/_emdash/api/search/rebuild", {
				collection: "posts",
			});

			await admin.goToDashboard();

			// Open command palette
			await page.keyboard.press(`${MOD_KEY}+k`);
			const input = page.getByPlaceholder("Search pages and content...");
			await expect(input).toBeVisible({ timeout: 5000 });

			// Type a query matching seeded posts
			await input.fill("First Post");

			// Wait for the Content group to appear (debounced search + API call)
			await expect(page.getByText("Content")).toBeVisible({ timeout: 10000 });

			// Should show "First Post" in the content results
			const contentResult = page
				.locator("[class*='ResultItem']", { hasText: "First Post" })
				.or(page.getByText("First Post").last());
			await expect(contentResult).toBeVisible({ timeout: 5000 });
		});

		test.fixme("navigates to content editor when selecting a content result", async ({
			// TODO: Command palette content search depends on suggest API which fails in dev
			admin,
			page,
			serverInfo,
		}) => {
			// Enable search and rebuild
			await enableSearch(serverInfo, "posts");
			await apiRequest(serverInfo, "POST", "/_emdash/api/search/rebuild", {
				collection: "posts",
			});

			await admin.goToDashboard();

			// Open command palette
			await page.keyboard.press(`${MOD_KEY}+k`);
			const input = page.getByPlaceholder("Search pages and content...");
			await expect(input).toBeVisible({ timeout: 5000 });

			// Search for a specific post
			await input.fill("Second Post");

			// Wait for content results to load
			await expect(page.getByText("Content")).toBeVisible({ timeout: 10000 });

			// Find and click the result -- use keyboard Enter to select
			// The first highlighted result should be a nav or content match
			// Press ArrowDown to navigate to content results if needed
			// Wait a moment for results to settle
			await page.waitForTimeout(500);

			// Press Enter to select the highlighted item, or click
			const secondPost = page.getByText("Second Post").last();
			await expect(secondPost).toBeVisible({ timeout: 5000 });
			await secondPost.click();

			// Should navigate to the content editor
			await expect(page).toHaveURL(CONTENT_POSTS_URL_PATTERN, { timeout: 10000 });
		});
	});
});
