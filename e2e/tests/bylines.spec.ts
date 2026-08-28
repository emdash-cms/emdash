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

	test("assigns bylines and preserves them on ownership change", async ({
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

		await createByline(primaryName, `primary-writer-${unique}`);
		await createByline(secondaryName, `secondary-writer-${unique}`);

		await admin.goToNewContent("posts");
		await admin.waitForLoading();
		await admin.fillField("title", `Byline E2E Post ${unique}`);
		await admin.clickSave();
		await expect(page).toHaveURL(CONTENT_EDIT_URL_PATTERN, { timeout: 10000 });

		const contentId = new URL(page.url()).pathname.split("/").pop();
		expect(contentId).toBeTruthy();
		await admin.waitForLoading();

		const bylinesSection = page
			.getByRole("heading", { name: "Bylines" })
			.locator("xpath=ancestor::section")
			.first();
		const addByline = async (displayName: string) => {
			await bylinesSection
				.getByRole("button", { name: /Choose bylines|Add another byline/ })
				.click();
			await page.getByLabel("Search bylines").fill(displayName);
			await page.getByRole("button", { name: `Add ${displayName}` }).click();
			await expect(
				bylinesSection.getByRole("button", { name: `More actions for ${displayName}` }),
			).toBeVisible();
		};

		await addByline(primaryName);
		await addByline(secondaryName);
		await admin.clickSave();
		await admin.waitForSaveComplete();

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

		const bylinesAfterReload = page
			.getByRole("heading", { name: "Bylines" })
			.locator("xpath=ancestor::section")
			.first();
		await expect(
			bylinesAfterReload.getByRole("button", { name: `More actions for ${primaryName}` }),
		).toBeVisible();
		await expect(
			bylinesAfterReload.getByRole("button", { name: `More actions for ${secondaryName}` }),
		).toBeVisible();

		const contentResponse = await fetch(
			`${serverInfo.baseUrl}/_emdash/api/content/posts/${contentId as string}`,
			{ headers },
		);
		expect(contentResponse.ok).toBe(true);
		const contentBody: any = await contentResponse.json();
		const names = (contentBody.data?.item?.bylines ?? []).map(
			(credit: { byline?: { displayName?: string } }) => credit?.byline?.displayName,
		);
		expect(names).toHaveLength(2);
		expect(names).toEqual(expect.arrayContaining([primaryName, secondaryName]));
	});
});
