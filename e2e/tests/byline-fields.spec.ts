/**
 * Byline Custom Fields E2E (Phase 7 of Discussion #1174)
 *
 * Proves the full round-trip: an admin registers a custom field via
 * `/byline-schema`, a byline is given a value through the edit form,
 * and the GET response on `/api/admin/bylines/{id}` returns the value
 * via `customFields.{slug}` — exercising every layer the PR touches
 * (registry, repository hydration, admin API, schema management UI,
 * byline edit form).
 *
 * Workers are pinned to 1 in `playwright.config.ts`, and
 * `global-setup.ts` rebuilds the fixture DB per `pnpm test:e2e`
 * invocation — so a fixed slug works without conflicting with itself
 * across runs. We still suffix with a timestamp because the same
 * `pnpm test:e2e` invocation may run this spec alongside others that
 * touch the bylines table.
 */

import { test, expect } from "../fixtures";

function apiHeaders(token: string, baseUrl: string): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${token}`,
		"X-EmDash-Request": "1",
		Origin: baseUrl,
	};
}

test.describe("Byline custom fields", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test("custom field value round-trips through the API end to end", async ({
		admin,
		page,
		serverInfo,
	}) => {
		const unique = Date.now();
		const fieldSlug = `job_title_${unique}`;
		const fieldLabel = `Job title ${unique}`;
		const bylineDisplayName = `Jane Custom ${unique}`;
		const bylineSlug = `jane-custom-${unique}`;
		const fieldValue = "Editor";

		// ---------------------------------------------------------------
		// 1. Register a custom field via /byline-schema
		// ---------------------------------------------------------------

		await admin.goto("/byline-schema");
		await admin.waitForLoading();

		await page.getByRole("button", { name: "New field" }).click();
		// `BylineFieldEditor` auto-fills the slug from the label
		// (Phase 5). Filling label first matches the production UX
		// flow; overriding slug afterwards proves the input is editable.
		await page.getByLabel("Label").fill(fieldLabel);
		await page.getByLabel("Slug").fill(fieldSlug);
		// Type defaults to `string` — leave it. `translatable` defaults
		// to true — leave it. Required stays off.
		await page.getByRole("button", { name: "Create field" }).click();

		// The new field row should show up in the schema table. Scope
		// the assertion to the table because the success toast also
		// contains the field label ("Created \"{label}\"."), and
		// Playwright's strict-mode locator rejects ambiguous matches.
		await expect(page.locator("table").getByText(fieldLabel)).toBeVisible({
			timeout: 5000,
		});

		// ---------------------------------------------------------------
		// 2. Create a byline via /bylines and select it
		// ---------------------------------------------------------------

		await admin.goto("/bylines");
		await admin.waitForLoading();

		await page.getByRole("button", { name: "New" }).click();
		await page.getByLabel("Display name").fill(bylineDisplayName);
		await page.getByLabel("Slug").fill(bylineSlug);
		// Guest byline keeps the form simple — no user-link side quest.
		await page.getByRole("switch", { name: "Guest byline" }).click();
		await page.getByRole("button", { name: "Create" }).click();

		// After create, the form moves to edit mode and the sidebar list
		// re-renders with the new byline highlighted. The "Custom fields"
		// section is conditional on `selected`, so it appears only after
		// the create completes.
		await expect(page.getByRole("button", { name: bylineDisplayName })).toBeVisible({
			timeout: 5000,
		});

		// ---------------------------------------------------------------
		// 3. Fill the custom field input and save
		// ---------------------------------------------------------------

		await expect(page.getByText("Custom fields")).toBeVisible();
		await page.getByLabel(fieldLabel).fill(fieldValue);
		await page.getByRole("button", { name: "Save" }).click();

		// ---------------------------------------------------------------
		// 4. Verify the round-trip via the REST API
		// ---------------------------------------------------------------

		// Find the byline id via the list endpoint (the sidebar's selected
		// row is keyed by id internally; reading via API is easier than
		// scraping the DOM). Filter by slug to avoid pagination concerns.
		const headers = apiHeaders(serverInfo.token, serverInfo.baseUrl);
		const listResponse = await fetch(
			`${serverInfo.baseUrl}/_emdash/api/admin/bylines?search=${encodeURIComponent(bylineSlug)}`,
			{ headers },
		);
		expect(listResponse.ok).toBe(true);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const listBody: any = await listResponse.json();
		const created = (listBody.data?.items ?? []).find(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(b: any) => b.slug === bylineSlug,
		);
		expect(created).toBeTruthy();
		expect(created.displayName).toBe(bylineDisplayName);

		const getResponse = await fetch(
			`${serverInfo.baseUrl}/_emdash/api/admin/bylines/${created.id}`,
			{ headers },
		);
		expect(getResponse.ok).toBe(true);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const getBody: any = await getResponse.json();
		const fetched = getBody.data;

		// The core assertion: the value we typed in the form is what
		// the API returns for the field slug. Goes through every layer:
		// admin UI form state → PATCH body → handler → BylineRepository
		// .update → translatable value table → hydration → GET response.
		expect(fetched.customFields).toBeTruthy();
		expect(fetched.customFields[fieldSlug]).toBe(fieldValue);
	});
});
