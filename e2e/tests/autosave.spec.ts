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
		const isPut = (res: any) => res.url().includes(contentUrl) && res.request().method() === "PUT";
		const isGet = (res: any) =>
			res.url().includes(contentUrl) &&
			!res.url().includes("/revisions") &&
			res.request().method() === "GET";

		await admin.goToEditContent(collectionSlug, postId);
		await admin.waitForLoading();

		const titleInput = admin.page.locator("#field-title");
		await expect(titleInput).toHaveValue("Original");

		// First edit — listen for both the PUT and the subsequent cache re-fetch GET
		const firstPut = admin.page.waitForResponse(isPut, { timeout: 10000 });
		await titleInput.fill("Edit One");
		await firstPut;

		// Wait for the cache invalidation GET to settle so form doesn't get overwritten
		const refetchGet = admin.page.waitForResponse(isGet, { timeout: 5000 }).catch(() => {});
		await refetchGet;
		// Extra settle time for React state updates
		await admin.page.waitForTimeout(500);

		// Check revision count after first autosave
		const res1 = await fetch(
			`${baseUrl}/_emdash/api/content/${collectionSlug}/${postId}/revisions`,
			{ headers },
		);
		const data1: any = await res1.json();
		const countAfterFirst = data1.data.total;

		// Second edit — set up listener BEFORE typing
		const secondPut = admin.page.waitForResponse(isPut, { timeout: 10000 });
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

	test("does not resend a rejected autosave until the content changes", async ({ admin }) => {
		await fetch(`${baseUrl}/_emdash/api/schema/collections/${collectionSlug}/fields`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				slug: "summary",
				type: "string",
				label: "Summary",
				validation: { maxLength: 10 },
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
		await summaryInput.fill("well over ten characters");
		expect((await rejectedPut).status()).toBe(400);

		await admin.page.waitForTimeout(7000);
		expect(putStatuses).toEqual([400]);
		await expect(summaryInput).toHaveValue("well over ten characters");

		const acceptedPut = admin.page.waitForResponse(isPut, { timeout: 10000 });
		await summaryInput.fill("short");
		expect((await acceptedPut).status()).toBe(200);
	});
});
