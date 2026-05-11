import { test, expect } from "../fixtures";

const CONTENT_EDIT_URL_PATTERN = /\/content\/posts\/[A-Z0-9]+$/;

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

		const firstBylineId = await createByline(primaryName, `primary-writer-${unique}`);
		const secondBylineId = await createByline(secondaryName, `secondary-writer-${unique}`);

		await admin.goToNewContent("posts");
		await admin.waitForLoading();
		await admin.fillField("title", `Byline E2E Post ${unique}`);
		await admin.clickSave();
		await expect(page).toHaveURL(CONTENT_EDIT_URL_PATTERN, { timeout: 10000 });

		const contentId = page.url().split("/").pop();
		expect(contentId).toBeTruthy();
		await admin.waitForLoading();

		// Scope the byline select to the Bylines section to avoid hitting the Ownership combobox
		const bylinesSidebar = page
			.getByRole("heading", { name: "Bylines" })
			.locator("xpath=ancestor::div[contains(@class,'p-4')]")
			.first();
		// Kumo's Select renders as a combobox button + popover, not a native <select>.
		const bylineCombobox = bylinesSidebar.getByRole("combobox").first();
		await bylineCombobox.click();
		await page.getByRole("option", { name: primaryName }).click();
		await bylinesSidebar.getByRole("button", { name: "Add" }).click();

		await bylineCombobox.click();
		await page.getByRole("option", { name: secondaryName }).click();
		await bylinesSidebar.getByRole("button", { name: "Add" }).click();

		await page.getByLabel("Role label").nth(1).fill("Co-author");
		await page.getByRole("button", { name: "Up" }).nth(1).click();

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
