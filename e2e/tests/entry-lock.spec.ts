/**
 * Entry edit lock E2E tests.
 *
 * Covers the lease mechanics the admin depends on: opening an entry takes the
 * lock, typing extends it rather than replacing it, and leaving the editor
 * hands it back.
 */

import { test, expect } from "../fixtures";

interface LockStatus {
	enabled: boolean;
	heldByCaller: boolean;
	holder: { userId: string; userName: string | null; acquiredAt: string; expiresAt: string } | null;
}

test.describe("Entry edit lock", () => {
	let collectionSlug: string;
	let postId: string;
	let headers: Record<string, string>;
	let baseUrl: string;

	async function readLock(): Promise<LockStatus> {
		const response = await fetch(
			`${baseUrl}/_emdash/api/content/${collectionSlug}/${postId}/lock`,
			{ headers },
		);
		const body = (await response.json()) as { data: LockStatus };
		return body.data;
	}

	test.beforeEach(async ({ admin, serverInfo }) => {
		await admin.devBypassAuth();

		baseUrl = serverInfo.baseUrl;
		headers = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${serverInfo.token}`,
			"X-EmDash-Request": "1",
			Origin: baseUrl,
		};

		collectionSlug = `lock_${Date.now()}`;
		await fetch(`${baseUrl}/_emdash/api/schema/collections`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				slug: collectionSlug,
				label: "Lock Test",
				labelSingular: "Lock Test",
				supports: ["revisions", "drafts"],
			}),
		});
		await fetch(`${baseUrl}/_emdash/api/schema/collections/${collectionSlug}/fields`, {
			method: "POST",
			headers,
			body: JSON.stringify({ slug: "title", type: "string", label: "Title", required: true }),
		});

		const createRes = await fetch(`${baseUrl}/_emdash/api/content/${collectionSlug}`, {
			method: "POST",
			headers,
			body: JSON.stringify({ data: { title: "Original" }, slug: "lock-test" }),
		});
		const created = (await createRes.json()) as { data?: { item?: { id: string } } };
		postId = created.data!.item!.id;
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

	test("opening an entry takes the lock and leaving hands it back", async ({ admin }) => {
		expect(await readLock()).toMatchObject({ enabled: true, holder: null });

		await admin.goToEditContent(collectionSlug, postId);
		await admin.waitForLoading();
		await expect(admin.page.locator("#field-title")).toHaveValue("Original");

		await expect
			.poll(async () => (await readLock()).holder?.userName, { timeout: 10000 })
			.toBe("Dev Admin");

		// Leave through the editor's own back link: a full page load tears the
		// document down without unmounting, and the lease has to expire instead.
		await admin.page.getByRole("link", { name: /Back to .* list/ }).click();
		await admin.waitForLoading();

		await expect.poll(async () => (await readLock()).holder, { timeout: 10000 }).toBeNull();
	});

	test("autosaving extends the lease instead of dropping it", async ({ admin }) => {
		const contentUrl = `/_emdash/api/content/${collectionSlug}/${postId}`;

		await admin.goToEditContent(collectionSlug, postId);
		await admin.waitForLoading();
		const titleInput = admin.page.locator("#field-title");
		await expect(titleInput).toHaveValue("Original");

		await expect
			.poll(async () => (await readLock()).holder !== null, { timeout: 10000 })
			.toBe(true);
		const before = (await readLock()).holder!.expiresAt;

		const autosave = admin.page.waitForResponse(
			(res) => res.url().includes(contentUrl) && res.request().method() === "PUT",
			{ timeout: 10000 },
		);
		await titleInput.fill("Edited while holding the lock");
		await autosave;

		const after = await readLock();
		expect(after.holder).not.toBeNull();
		expect(after.holder!.expiresAt > before).toBe(true);
	});

	test("takes no lock on a collection with locking switched off", async ({ admin }) => {
		await fetch(`${baseUrl}/_emdash/api/schema/collections/${collectionSlug}`, {
			method: "PUT",
			headers,
			body: JSON.stringify({ editLocking: false }),
		});

		await admin.goToEditContent(collectionSlug, postId);
		await admin.waitForLoading();
		await expect(admin.page.locator("#field-title")).toHaveValue("Original");

		const status = await readLock();
		expect(status.enabled).toBe(false);
		expect(status.holder).toBeNull();
	});
});
