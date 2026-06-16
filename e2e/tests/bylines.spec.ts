import { join } from "node:path";

import { test, expect } from "../fixtures";

// The edit route preserves the entry's locale as a `?locale=` search param
// (see #1242), so the URL may carry a query string after the ULID.
const CONTENT_EDIT_URL_PATTERN = /\/content\/posts\/[A-Z0-9]+(?:\?.*)?$/;

// Shared 1x1 PNG fixture used by the media upload flows.
const TEST_IMAGE_PATH = join(process.cwd(), "e2e/fixtures/assets/test-image.png");

function apiHeaders(token: string, baseUrl: string) {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${token}`,
		"X-EmDash-Request": "1",
		Origin: baseUrl,
	};
}

test.describe("Bylines", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test("creates and edits a guest byline in admin", async ({ admin, page }) => {
		const unique = Date.now();
		const initialName = `Guest Byline ${unique}`;
		const updatedName = `Guest Byline Updated ${unique}`;

		await admin.goto("/bylines");
		await admin.waitForShell();
		await admin.waitForLoading();

		await page.getByRole("button", { name: "New" }).click();
		await page.getByLabel("Display name").fill(initialName);
		await page.getByLabel("Slug").fill(`guest-byline-${unique}`);
		await page.getByRole("switch", { name: "Guest byline" }).click();
		await page.getByRole("button", { name: "Create" }).click();

		await expect(page.getByRole("button", { name: initialName })).toBeVisible({ timeout: 5000 });

		await page.getByRole("button", { name: initialName }).click();
		await page.getByLabel("Display name").fill(updatedName);
		await page.getByRole("button", { name: "Save" }).click();

		await expect(page.getByRole("button", { name: updatedName })).toBeVisible({ timeout: 5000 });
	});

	test("sets a byline avatar via the media picker and preserves it across edits (#1250)", async ({
		admin,
		page,
		serverInfo,
	}) => {
		const unique = Date.now();
		const name = `Avatar Byline ${unique}`;
		const slug = `avatar-byline-${unique}`;
		const headers = apiHeaders(serverInfo.token, serverInfo.baseUrl);

		const getByline = async (id: string) => {
			const response = await fetch(`${serverInfo.baseUrl}/_emdash/api/admin/bylines/${id}`, {
				headers,
			});
			expect(response.ok).toBe(true);
			const body: any = await response.json();
			return body.data as { avatarMediaId: string | null };
		};

		// Create the byline up front via API so there's a stable id to assert
		// against. It starts with no avatar — the field had no UI control before
		// this fix, so the only way to set it was programmatically.
		const createResponse = await fetch(`${serverInfo.baseUrl}/_emdash/api/admin/bylines`, {
			method: "POST",
			headers,
			body: JSON.stringify({ displayName: name, slug, isGuest: true }),
		});
		expect(createResponse.ok).toBe(true);
		const createBody: any = await createResponse.json();
		const bylineId = createBody.data.id as string;
		expect(createBody.data.avatarMediaId).toBeNull();

		await admin.goto("/bylines");
		await admin.waitForShell();
		await admin.waitForLoading();

		// Open the byline in the editor and confirm the avatar field renders.
		await page.getByRole("button", { name }).click();
		await expect(page.getByText("Avatar", { exact: true })).toBeVisible();

		// Open the avatar picker and upload an image. The picker auto-selects
		// the freshly uploaded item, enabling the Insert button.
		await page.getByRole("button", { name: "Select image" }).click();
		const dialog = page.locator('[role="dialog"]').filter({ hasText: "Select Avatar" });
		await expect(dialog).toBeVisible();

		const uploadDone = page.waitForResponse(
			(res) => /\/api\/media/.test(res.url()) && res.request().method() === "POST" && res.ok(),
			{ timeout: 15000 },
		);
		await dialog.locator('input[type="file"]').setInputFiles(TEST_IMAGE_PATH);
		await uploadDone;

		// Two "Insert" buttons exist (the disabled "Insert from URL" action and
		// the footer confirm); the confirm enables once an item is selected.
		await dialog.getByRole("button", { name: "Insert", disabled: false }).click();
		await expect(dialog).not.toBeVisible();

		// Persist the byline and wait for the PUT to land.
		const firstSave = page.waitForResponse(
			(res) =>
				res.url().includes(`/api/admin/bylines/${bylineId}`) &&
				res.request().method() === "PUT" &&
				res.ok(),
			{ timeout: 10000 },
		);
		await page.getByRole("button", { name: "Save" }).click();
		await firstSave;

		// The avatar id is now persisted through the UI.
		const afterSet = await getByline(bylineId);
		expect(afterSet.avatarMediaId).toBeTruthy();
		const avatarId = afterSet.avatarMediaId;

		// Regression guard for #1250: editing another field through the UI must
		// not wipe the avatar. The PUT route coerces a missing `avatarMediaId`
		// back to null, so before the fix every save dropped the avatar.
		await page.getByLabel("Display name").fill(`${name} edited`);
		const secondSave = page.waitForResponse(
			(res) =>
				res.url().includes(`/api/admin/bylines/${bylineId}`) &&
				res.request().method() === "PUT" &&
				res.ok(),
			{ timeout: 10000 },
		);
		await page.getByRole("button", { name: "Save" }).click();
		await secondSave;

		const afterEdit = await getByline(bylineId);
		expect(afterEdit.avatarMediaId).toBe(avatarId);
	});

	test("assigns and reorders bylines, preserves bylines on ownership change", async ({
		admin,
		page,
		serverInfo,
	}) => {
		const unique = Date.now();
		const primaryName = `Primary Writer ${unique}`;
		const secondaryName = `Secondary Writer ${unique}`;
		const headers = apiHeaders(serverInfo.token, serverInfo.baseUrl);

		const createByline = async (displayName: string, slug: string) => {
			const response = await fetch(`${serverInfo.baseUrl}/_emdash/api/admin/bylines`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					displayName,
					slug,
					isGuest: true,
				}),
			});
			expect(response.ok).toBe(true);
			const body: any = await response.json();
			return body.data.id as string;
		};

		// Create two bylines for the test post. IDs aren't needed downstream;
		// the test selects them by name via the bylines combobox.
		await createByline(primaryName, `primary-writer-${unique}`);
		await createByline(secondaryName, `secondary-writer-${unique}`);

		await admin.goToNewContent("posts");
		await admin.waitForLoading();
		await admin.fillField("title", `Byline E2E Post ${unique}`);
		await admin.clickSave();
		await expect(page).toHaveURL(CONTENT_EDIT_URL_PATTERN, { timeout: 10000 });

		const contentId = page.url().split("/").pop();
		expect(contentId).toBeTruthy();
		await admin.waitForLoading();

		// Scope the byline picker to the Bylines section to avoid hitting the Ownership combobox
		const bylinesSidebar = page
			.getByRole("heading", { name: "Bylines" })
			.locator("xpath=ancestor::div[contains(@class,'p-4')]")
			.first();
		// The picker is a debounced server search: type a name, wait for the result
		// button to appear, click it, then wait for the credit row to commit before
		// the next add (the search debounce + React commit race otherwise drops one).
		const bylineSearch = bylinesSidebar.getByLabel("Search bylines");
		const creditRow = (displayName: string) =>
			bylinesSidebar.locator("p.text-sm.font-medium").filter({ hasText: displayName });
		const addByline = async (displayName: string) => {
			await bylineSearch.fill(displayName);
			const result = bylinesSidebar.getByRole("button", { name: displayName });
			await expect(result).toBeVisible({ timeout: 5000 });
			await result.click();
			await expect(creditRow(displayName)).toBeVisible({ timeout: 5000 });
		};

		await addByline(primaryName);
		await addByline(secondaryName);

		// Move the secondary credit above the primary via its own row's "Up" button,
		// then confirm the reorder committed before saving.
		const secondaryCreditRow = bylinesSidebar
			.locator("div.rounded.border.p-2")
			.filter({ hasText: secondaryName });
		await secondaryCreditRow.getByLabel("Role label").fill("Co-author");
		await secondaryCreditRow.getByRole("button", { name: "Up" }).click();
		await expect(bylinesSidebar.locator("p.text-sm.font-medium").first()).toContainText(
			secondaryName,
		);

		await admin.clickSave();
		await admin.waitForSaveComplete();

		await expect(bylinesSidebar.locator("p.text-sm.font-medium").first()).toContainText(
			secondaryName,
		);

		const ownershipUpdateResponse = await fetch(
			`${serverInfo.baseUrl}/_emdash/api/content/posts/${contentId as string}`,
			{
				method: "PUT",
				headers,
				body: JSON.stringify({ authorId: null }),
			},
		);
		expect(ownershipUpdateResponse.ok).toBe(true);

		await page.reload();
		await admin.waitForShell();
		await admin.waitForLoading();

		const bylineSectionAfterReload = page
			.getByRole("heading", { name: "Bylines" })
			.locator("xpath=ancestor::div[contains(@class,'p-4')]")
			.first();

		await expect(bylineSectionAfterReload.locator("p.text-sm.font-medium").first()).toContainText(
			secondaryName,
		);

		const contentResponse = await fetch(
			`${serverInfo.baseUrl}/_emdash/api/content/posts/${contentId as string}`,
			{ headers },
		);
		expect(contentResponse.ok).toBe(true);
		const contentBody: any = await contentResponse.json();
		const item = contentBody.data?.item;

		expect(item.byline?.displayName).toBe(secondaryName);
		expect(item.bylines).toHaveLength(2);
		expect(item.bylines[0]?.byline?.displayName).toBe(secondaryName);
		expect(item.bylines[1]?.byline?.displayName).toBe(primaryName);
		const secondaryCredit = item.bylines.find(
			(credit: any) => credit?.byline?.displayName === secondaryName,
		);
		expect(secondaryCredit?.roleLabel).toBe("Co-author");
	});
});
