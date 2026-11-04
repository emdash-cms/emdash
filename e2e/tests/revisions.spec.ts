/**
 * Revision history E2E tests: the Revisions list, the read-only version view
 * in the canvas, and restoring a version.
 */

import type { Locator, Page } from "@playwright/test";

import { test, expect, type AdminPage } from "../fixtures";

const REVISIONS_TRIGGER = /^Revisions/;
const VERSION_VIEW = /^Version from /;
const RESTORED_CURRENT_ROW = /, Current version, Dev Admin, Restored from \u2068?.+\u2069?$/u;
const PUBLISHED_ROW = /, Published, Dev Admin$/;
const INSERTED_RED = /(?:^|\s)red$/;
const REMOVED_BROWN = /(?:^|\s)brown$/;
// Interpolated values in change labels are wrapped in Unicode isolates.
const EDITED_EXCERPT = /^Edited \u2068?Excerpt\u2069?$/u;
const EDITED_FOX = /^Edited “\u2068?The quick red fox jumps…\u2069?”$/u;
const RESTORED_FROM = /^Restored the version from \u2068?.+\u2069?$/u;

function paragraph(key: string, text: string) {
	return {
		_type: "block",
		_key: key,
		style: "normal",
		markDefs: [],
		children: [{ _type: "span", _key: `${key}-span`, text, marks: [] }],
	};
}

// Keeps the edited paragraph below the fold, so jumping to it has to scroll.
const FILLER = Array.from({ length: 20 }, (_, index) =>
	paragraph(`filler${index}`, `Filler paragraph ${index + 1} keeps the edited line out of view.`),
);

function body(foxColor: string) {
	return [...FILLER, paragraph("fox", `The quick ${foxColor} fox jumps over the lazy dog.`)];
}

const ORIGINAL = { title: "Original Title", excerpt: "Original excerpt", body: body("brown") };
const REVISED = { title: "Revised Title", excerpt: "Revised excerpt", body: body("red") };
const LATEST = { title: "Latest Title", excerpt: "Revised excerpt", body: body("grey") };

function versionView(page: Page): Locator {
	return page.getByRole("article", { name: VERSION_VIEW });
}

function versionBar(page: Page): Locator {
	return page
		.getByRole("region")
		.filter({ has: page.getByRole("button", { name: "Back to editing" }) });
}

function changeList(page: Page): Locator {
	return page.getByRole("list", { name: "Changes in this version" });
}

async function expandRevisions(scope: Page | Locator): Promise<Locator> {
	await scope.getByRole("button", { name: REVISIONS_TRIGGER }).click();
	const rows = scope.locator("[data-revision-row]");
	await expect(rows).toHaveCount(3);
	return rows;
}

test.describe("Revisions", () => {
	let collectionSlug: string;
	let postId: string;
	let headers: Record<string, string>;
	let baseUrl: string;

	async function api(method: string, path: string, data?: unknown): Promise<Response> {
		const response = await fetch(`${baseUrl}/_emdash/api${path}`, {
			method,
			headers,
			body: data === undefined ? undefined : JSON.stringify(data),
		});
		expect(response.ok, `${method} ${path} returned ${response.status}`).toBe(true);
		return response;
	}

	async function openEditor(admin: AdminPage): Promise<void> {
		await admin.goToEditContent(collectionSlug, postId);
		await admin.waitForLoading();
		await expect(admin.page.locator("#field-title")).toHaveValue(LATEST.title);
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

		collectionSlug = `rev_test_${Date.now()}`;
		await api("POST", "/schema/collections", {
			slug: collectionSlug,
			label: "Revision Test",
			labelSingular: "Revision Test",
			supports: ["revisions", "drafts"],
		});
		const fieldsPath = `/schema/collections/${collectionSlug}/fields`;
		await api("POST", fieldsPath, {
			slug: "title",
			type: "string",
			label: "Title",
			required: true,
		});
		await api("POST", fieldsPath, { slug: "excerpt", type: "text", label: "Excerpt" });
		await api("POST", fieldsPath, { slug: "body", type: "portableText", label: "Body" });

		const created = (await (
			await api("POST", `/content/${collectionSlug}`, {
				data: ORIGINAL,
				slug: "revision-test-post",
			})
		).json()) as { data: { item: { id: string } } };
		postId = created.data.item.id;

		// Creating an entry saves no revision, so each version is a PUT, which
		// records the token's user as the revision's author.
		const entryPath = `/content/${collectionSlug}/${postId}`;
		await api("PUT", entryPath, { data: ORIGINAL });
		await api("PUT", entryPath, { data: REVISED });
		await api("POST", `${entryPath}/publish`, {});
		await api("PUT", entryPath, { data: LATEST });
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

	test("shows an older version read-only, with change marks that Show changes hides", async ({
		admin,
		page,
	}) => {
		await openEditor(admin);
		const rows = await expandRevisions(page);
		await rows.nth(1).click();

		const canvas = versionView(page);
		await expect(canvas).toBeVisible();
		await expect(page.locator("#field-title")).toBeHidden();
		await expect(canvas.getByRole("textbox")).toHaveCount(0);
		await expect(canvas.getByRole("group", { name: "Title", exact: true })).toContainText(
			REVISED.title,
		);

		const bodyField = canvas.getByRole("group", { name: "Body", exact: true });
		await expect(bodyField.locator("ins")).toHaveText(INSERTED_RED);
		await expect(bodyField.locator("del")).toHaveText(REMOVED_BROWN);

		await expect(changeList(page).getByRole("listitem")).toHaveText([
			"Changed the title",
			EDITED_EXCERPT,
			EDITED_FOX,
		]);

		const showChanges = versionBar(page).getByRole("switch", { name: "Show changes" });
		await showChanges.click();
		await expect(canvas.locator("del")).toHaveCount(0);
		await expect(canvas.locator("ins")).toHaveCount(0);
		await expect(bodyField).toContainText("The quick red fox jumps over the lazy dog.");
		await showChanges.click();
		await expect(bodyField.locator("del")).toHaveText(REMOVED_BROWN);
	});

	test("clicking a change scrolls to it and focuses it", async ({ admin, page }) => {
		await openEditor(admin);
		const rows = await expandRevisions(page);
		await rows.nth(1).click();

		const canvas = versionView(page);
		const fox = canvas
			.getByRole("group", { name: "Body", exact: true })
			.locator("p", { hasText: "fox jumps over" });
		await expect(fox).toBeVisible();
		await expect(fox).not.toBeInViewport();

		const changes = changeList(page);
		await changes.getByRole("button", { name: EDITED_FOX }).click();
		await expect(fox).toBeFocused();
		await expect(fox).toBeInViewport();
		await expect(fox.locator("ins")).toHaveText(INSERTED_RED);

		const title = canvas.getByRole("group", { name: "Title", exact: true });
		await changes.getByRole("button", { name: "Changed the title", exact: true }).click();
		await expect(title).toBeFocused();
		await expect(title).toBeInViewport();
		await expect(title).toContainText(REVISED.title);
	});

	test("Back to editing returns to the editor with unsaved edits intact", async ({
		admin,
		page,
	}) => {
		await openEditor(admin);
		const titleInput = page.locator("#field-title");
		await titleInput.fill("Unsaved title edit");

		const rows = await expandRevisions(page);
		await rows.nth(1).click();
		const canvas = versionView(page);
		await expect(canvas).toBeVisible();
		await expect(titleInput).toBeHidden();

		await versionBar(page).getByRole("button", { name: "Back to editing" }).click();
		await expect(canvas).toHaveCount(0);
		await expect(titleInput).toBeVisible();
		await expect(titleInput).toHaveValue("Unsaved title edit");
	});

	test("restoring a version makes it the current draft", async ({ admin, page }) => {
		await openEditor(admin);
		const rows = await expandRevisions(page);
		await rows.nth(1).click();
		const canvas = versionView(page);
		await expect(canvas).toBeVisible();

		await versionBar(page).getByRole("button", { name: "Restore", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "Restore this version?" });
		await dialog.getByRole("button", { name: "Restore", exact: true }).click();

		await expect(page.getByRole("heading", { name: "Version restored" })).toBeVisible();
		await expect(dialog).toBeHidden();
		await expect(canvas).toHaveCount(0);
		await expect(page.locator("#field-title")).toHaveValue(REVISED.title);
		const bodyEditor = page.locator("#field-body");
		await expect(bodyEditor).toContainText("The quick red fox jumps over the lazy dog.");
		await expect(bodyEditor).not.toContainText("grey");

		await expect(rows).toHaveCount(4);
		await expect(rows.nth(0)).toHaveAccessibleName(RESTORED_CURRENT_ROW);
		await expect(rows.nth(0)).toBeFocused();
		await expect(rows.nth(2)).toHaveAccessibleName(PUBLISHED_ROW);

		await rows.nth(0).click();
		await expect(canvas).toBeVisible();
		await expect(changeList(page).getByRole("listitem").first()).toBeVisible();
		await expect(changeList(page).getByText(RESTORED_FROM)).toHaveCount(0);
		const restore = versionBar(page).getByRole("button", { name: "Restore", exact: true });
		await expect(restore).toHaveCount(0);

		await rows.nth(2).click();
		await expect(versionBar(page)).toContainText("Same as current version");
		await expect(restore).toHaveCount(0);
	});

	test("on a phone, versions open from the settings sheet and step with arrows", async ({
		admin,
		page,
	}) => {
		await openEditor(admin);
		await page.setViewportSize({ width: 390, height: 844 });

		await page.getByRole("button", { name: "Settings", exact: true }).click();
		const sheet = page.getByRole("navigation", { name: "Settings" });
		await expect(sheet).toBeVisible();
		const rows = await expandRevisions(sheet);
		await rows.nth(0).click();
		await expect(sheet).toBeHidden();

		const canvas = versionView(page);
		const bar = versionBar(page);
		const older = bar.getByRole("button", { name: "Older version" });
		const newer = bar.getByRole("button", { name: "Newer version" });
		await expect(canvas.getByRole("group", { name: "Title", exact: true })).toContainText(
			LATEST.title,
		);
		await expect(bar).toContainText("Current version");
		await expect(newer).toBeDisabled();

		await older.click();
		await expect(canvas.getByRole("group", { name: "Title", exact: true })).toContainText(
			REVISED.title,
		);
		await expect(bar).toContainText("Published");
		await expect(bar).not.toContainText("Current version");
		await expect(newer).toBeEnabled();

		await bar.getByRole("button", { name: "Back to editing" }).click();
		await expect(canvas).toHaveCount(0);
		await expect(page.locator("#field-title")).toBeVisible();
	});
});
