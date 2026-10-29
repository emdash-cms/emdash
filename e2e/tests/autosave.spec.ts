/**
 * Autosave E2E Tests
 *
 * Tests that autosave updates the existing draft revision in place
 * rather than creating a new revision on each keystroke.
 *
 * Covers issue #5: skipRevision was stripped by Zod validation,
 * causing every autosave to create a new revision.
 */

import { test, expect } from "../fixtures";

test.describe("Autosave", () => {
	let collectionSlug: string;
	let postId: string;
	let headers: Record<string, string>;
	let baseUrl: string;

	test.beforeEach(async ({ admin, serverInfo }) => {
		await admin.devBypassAuth();

		baseUrl = serverInfo.baseUrl;
		headers = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${serverInfo.token}`,
			"X-EmDash-Request": "1",
			Origin: baseUrl,
		};

		// Create a collection with revision support
		collectionSlug = `autosave_${Date.now()}`;
		await fetch(`${baseUrl}/_emdash/api/schema/collections`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				slug: collectionSlug,
				label: "Autosave Test",
				labelSingular: "Autosave Test",
				supports: ["revisions", "drafts"],
			}),
		});

		await fetch(`${baseUrl}/_emdash/api/schema/collections/${collectionSlug}/fields`, {
			method: "POST",
			headers,
			body: JSON.stringify({ slug: "title", type: "string", label: "Title", required: true }),
		});

		// Create and publish a post
		const createRes = await fetch(`${baseUrl}/_emdash/api/content/${collectionSlug}`, {
			method: "POST",
			headers,
			body: JSON.stringify({ data: { title: "Original" }, slug: "autosave-test" }),
		});
		const createData: any = await createRes.json();
		postId = createData.data?.item?.id ?? createData.data?.id;

		await fetch(`${baseUrl}/_emdash/api/content/${collectionSlug}/${postId}/publish`, {
			method: "POST",
			headers,
			body: JSON.stringify({}),
		});
	});

	test.afterEach(async () => {
		await fetch(`${baseUrl}/_emdash/api/content/${collectionSlug}/${postId}`, {
			method: "DELETE",
			headers,
		}).catch(() => {});
		await fetch(`${baseUrl}/_emdash/api/schema/collections/${collectionSlug}`, {
			method: "DELETE",
			headers,
		}).catch(() => {});
	});

	test("multiple autosaves update draft in place instead of creating new revisions", async ({
		admin,
	}) => {
		const contentUrl = `/_emdash/api/content/${collectionSlug}/${postId}`;
		const isPutOf = (title: string) => (res: any) =>
			res.url().includes(contentUrl) &&
			res.request().method() === "PUT" &&
			(res.request().postData() ?? "").includes(title);

		await admin.goToEditContent(collectionSlug, postId);
		await admin.waitForLoading();

		const titleInput = admin.page.locator("#field-title");
		await expect(titleInput).toHaveValue("Original");

		const firstPut = admin.page.waitForResponse(isPutOf("Edit One"), { timeout: 10000 });
		await titleInput.fill("Edit One");
		await firstPut;
		await admin.waitForSaveComplete();
		await expect(admin.page.getByRole("status").filter({ hasText: "Saved" })).toHaveText("Saved");

		// Check revision count after first autosave
		const res1 = await fetch(
			`${baseUrl}/_emdash/api/content/${collectionSlug}/${postId}/revisions`,
			{ headers },
		);
		const data1: any = await res1.json();
		const countAfterFirst = data1.data.total;

		// Second edit — set up listener BEFORE typing
		const secondPut = admin.page.waitForResponse(isPutOf("Edit Two"), { timeout: 10000 });
		await titleInput.fill("Edit Two");
		await secondPut;

		// Check revision count — should be same (updated in place, not new revision)
		const res2 = await fetch(
			`${baseUrl}/_emdash/api/content/${collectionSlug}/${postId}/revisions`,
			{ headers },
		);
		const data2: any = await res2.json();
		const countAfterSecond = data2.data.total;

		expect(countAfterSecond).toBe(countAfterFirst);

		// Verify the latest revision contains the last autosaved data
		const latestRevision = data2.data.items?.[0];
		expect(latestRevision?.data?.title).toBe("Edit Two");
	});

	test("keeps an explicit draft checkpoint from mobile Settings through later autosaves", async ({
		admin,
		page,
	}) => {
		await admin.goToEditContent(collectionSlug, postId);
		await admin.waitForLoading();
		await page.setViewportSize({ width: 390, height: 800 });
		const contentUrl = `/_emdash/api/content/${collectionSlug}/${postId}`;
		const title = page.locator("#field-title");
		const firstAutosave = page.waitForResponse(
			(response) => response.url().includes(contentUrl) && response.request().method() === "PUT",
		);
		await title.fill("Mobile checkpoint");
		expect((await firstAutosave).status()).toBe(200);
		await admin.waitForSaveComplete();
		const before = await (await fetch(`${baseUrl}${contentUrl}/revisions`, { headers })).json();
		const checkpointId = before.data.items.find(
			(revision: { data: { title: string } }) => revision.data.title === "Mobile checkpoint",
		).id;

		await page.getByRole("button", { name: "Settings", exact: true }).click();
		const manualSave = page.waitForResponse(
			(response) => response.url().includes(contentUrl) && response.request().method() === "PUT",
		);
		await page.getByRole("button", { name: "Save draft", exact: true }).click();
		const manualResponse = await manualSave;
		expect(manualResponse.status()).toBe(200);
		expect(manualResponse.request().postDataJSON()).not.toHaveProperty("skipRevision");
		await admin.waitForSaveComplete();
		await page.getByRole("button", { name: "Close settings", exact: true }).click();
		await title.click();
		await expect(title).toBeFocused();

		const laterAutosave = page.waitForResponse(
			(response) =>
				response.url().includes(contentUrl) &&
				response.request().method() === "PUT" &&
				response.request().postDataJSON()?.data?.title === "Later changes",
		);
		await title.fill("Later changes");
		await expect(title).toHaveValue("Later changes");
		expect((await laterAutosave).status()).toBe(200);
		await admin.waitForSaveComplete();
		const after = await (await fetch(`${baseUrl}${contentUrl}/revisions`, { headers })).json();
		expect(after.data.items).toContainEqual(
			expect.objectContaining({ data: expect.objectContaining({ title: "Later changes" }) }),
		);
		expect(after.data.items).toContainEqual(
			expect.objectContaining({
				id: checkpointId,
				data: expect.objectContaining({ title: "Mobile checkpoint" }),
			}),
		);
		await expect(page.getByRole("status").filter({ hasText: "Saved" })).toHaveText("Saved");
		await expect(title).toHaveValue("Later changes");
	});

	test("does not resend a rejected autosave until the content changes", async ({ admin }) => {
		await fetch(`${baseUrl}/_emdash/api/schema/collections/${collectionSlug}/fields`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				slug: "summary",
				type: "string",
				label: "Summary",
				validation: { minLength: 10 },
			}),
		});

		const contentUrl = `/_emdash/api/content/${collectionSlug}/${postId}`;
		const isPut = (res: any) => res.url().includes(contentUrl) && res.request().method() === "PUT";
		const putStatuses: number[] = [];
		admin.page.on("response", (res) => {
			if (isPut(res)) putStatuses.push(res.status());
		});

		await admin.goToEditContent(collectionSlug, postId);
		await admin.waitForLoading();

		const summaryInput = admin.page.locator("#field-summary");
		const rejectedPut = admin.page.waitForResponse(isPut, { timeout: 10000 });
		await summaryInput.fill("short");
		expect((await rejectedPut).status()).toBe(400);

		await admin.page.waitForTimeout(7000);
		expect(putStatuses).toEqual([400]);
		await expect(summaryInput).toHaveValue("short");

		const acceptedPut = admin.page.waitForResponse(isPut, { timeout: 10000 });
		await summaryInput.fill("long enough now");
		expect((await acceptedPut).status()).toBe(200);
	});

	test("names the rejected field by its label", async ({ admin }) => {
		await fetch(`${baseUrl}/_emdash/api/schema/collections/${collectionSlug}/fields`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				slug: "excerpt",
				type: "string",
				label: "Summary",
				validation: { minLength: 10 },
			}),
		});

		const contentUrl = `/_emdash/api/content/${collectionSlug}/${postId}`;
		const isPut = (res: any) => res.url().includes(contentUrl) && res.request().method() === "PUT";

		await admin.goToEditContent(collectionSlug, postId);
		await admin.waitForLoading();

		const rejectedPut = admin.page.waitForResponse(isPut, { timeout: 10000 });
		await admin.page.locator("#field-excerpt").fill("short");
		expect((await rejectedPut).status()).toBe(400);

		await expect(
			admin.page
				.getByRole("alert")
				.getByText("Summary needs at least 10 characters.", { exact: true }),
		).toBeVisible();
		await expect(admin.page.getByText("excerpt:", { exact: false })).toHaveCount(0);
	});
});
