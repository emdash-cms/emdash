import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "../fixtures";

test.describe("Sandboxed plugin admin surfaces", () => {
	test.skip(
		process.env.EMDASH_E2E_TARGET === "cloudflare",
		"The Node lane owns the exhaustive rendered interactions; Cloudflare runs the parity smoke",
	);

	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test("renders dashboard widgets from the sandbox", async ({ admin, page }) => {
		await admin.goto("/");
		await admin.waitForLoading();
		await expect(page.getByRole("heading", { name: "Capability status" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Granted authority" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Registry diagnostics" }).first()).toBeVisible();
	});

	test("saves every generated settings shape and keeps the secret write-only", async ({
		admin,
		page,
	}) => {
		await admin.goto("/plugins-manager/marketplace-test/settings");
		await admin.waitForLoading();

		await page.getByRole("textbox", { name: "Display name" }).fill("Browser fixture");
		await page.getByRole("textbox", { name: "Notes" }).fill("Saved through the real admin");
		await page.getByRole("spinbutton", { name: "Threshold" }).fill("42");
		await page.getByRole("switch", { name: "Enabled" }).click();
		await page.getByLabel("Mode").click();
		await page.getByRole("option", { name: "Exercise" }).click();
		await page.getByRole("textbox", { name: "Endpoint" }).fill("https://api.example.test");
		await page.getByRole("textbox", { name: "Recipient" }).fill("admin@example.test");
		await page.getByLabel("API key").fill("browser-secret");
		await page.getByRole("button", { name: "Save Settings" }).first().click();
		await expect(page.getByText("Settings saved successfully", { exact: true })).toBeVisible();

		await page.reload();
		await admin.waitForLoading();
		await expect(page.getByRole("textbox", { name: "Display name" })).toHaveValue(
			"Browser fixture",
		);
		await expect(page.getByRole("spinbutton", { name: "Threshold" })).toHaveValue("42");
		await expect(page.getByLabel("API key")).toHaveValue("");
		await expect(page.getByLabel("API key")).toHaveAttribute(
			"placeholder",
			"Currently set — enter a new value to replace",
		);

		const secret = await page.request.post("/_emdash/api/plugins/marketplace-test/secret-value", {
			headers: { "X-EmDash-Request": "1" },
			data: {},
		});
		await expect(secret.json()).resolves.toMatchObject({
			data: { viaSettings: "browser-secret", viaCompatibilityAlias: "browser-secret" },
		});
	});

	test("persists a declarative field widget through the content editor", async ({
		admin,
		page,
	}) => {
		await admin.goToNewContent("posts");
		await admin.waitForLoading();
		await admin.fillField("title", `Sandbox widget ${crypto.randomUUID()}`);
		await page.getByRole("textbox", { name: "Event ID" }).fill("event-42");
		await page.getByRole("spinbutton", { name: "Capacity" }).fill("250");
		await page.getByRole("switch", { name: "Featured" }).click();
		await page.getByLabel("Kind").click();
		await page.getByRole("option", { name: "Meetup" }).click();
		await expect(page.getByRole("button", { name: "Select media" })).toBeVisible();

		await admin.clickSave();
		await admin.waitForSaveComplete();
		await page.reload();
		await admin.waitForLoading();
		await expect(page.getByRole("textbox", { name: "Event ID" })).toHaveValue("event-42");
		await expect(page.getByRole("spinbutton", { name: "Capacity" })).toHaveValue("250");
		await expect(page.getByRole("switch", { name: "Featured" })).toBeChecked();
		await expect(page.getByLabel("Kind")).toHaveText(/Meetup/);
	});

	test("records content hooks triggered by save and publish in the admin", async ({
		admin,
		page,
	}) => {
		await admin.goToNewContent("posts");
		await admin.waitForLoading();
		await admin.fillField("title", `Sandbox hook ${crypto.randomUUID()}`);
		await admin.clickSave();
		await admin.waitForSaveComplete();
		const contentId = new URL(page.url()).pathname.split("/").at(-1);
		expect(contentId).toBeTruthy();

		await page.getByRole("button", { name: "Publish now", exact: true }).click();
		await page
			.getByRole("dialog", { name: "Publish now?" })
			.getByRole("button", { name: "Publish now", exact: true })
			.click();
		await expect(page.getByText("Live version", { exact: true })).toBeVisible();

		const response = await page.request.post("/_emdash/api/plugins/marketplace-test/events-list", {
			headers: { "X-EmDash-Request": "1" },
			data: {},
		});
		const body = (await response.json()) as {
			data: { events: { items: Array<{ id: string; data: Record<string, unknown> }> } };
		};
		expect(body.data.events.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: contentId, data: { type: "saved", collection: "posts" } }),
				expect.objectContaining({
					id: `action:publish:${contentId}`,
					data: { type: "content-action", action: "publish", contentId },
				}),
			]),
		);
	});

	test("records a media hook after an admin upload and metadata edit", async ({ admin, page }) => {
		const filename = `sandbox-media-${crypto.randomUUID()}.png`;
		await admin.goToMedia();
		await admin.waitForLoading();
		await page
			.getByRole("button", { name: /Upload/ })
			.first()
			.click();
		const uploadDialog = page.getByRole("dialog");
		await uploadDialog.getByLabel("Browse files to upload").setInputFiles({
			name: filename,
			mimeType: "image/png",
			buffer: Buffer.concat([
				readFileSync(join(process.cwd(), "e2e/fixtures/assets/test-image.png")),
				Buffer.from(filename),
			]),
		});
		await expect(uploadDialog.getByText("Complete", { exact: true })).toBeVisible();
		await uploadDialog.getByRole("button", { name: "Done" }).click();
		await admin.waitForLoading();
		await page.locator('input[type="search"]').fill(filename);
		await page.getByRole("button", { name: filename, exact: true }).click();
		const mediaDialog = page.getByRole("dialog", { name: "Media details" });
		await expect(mediaDialog).toBeVisible();
		await mediaDialog.getByLabel("Alt Text").fill("Sandboxed hook upload");
		const save = mediaDialog.getByRole("button", { name: "Save", exact: true });
		await expect(save).toBeEnabled();
		await save.click();

		const response = await page.request.post("/_emdash/api/plugins/marketplace-test/events-list", {
			headers: { "X-EmDash-Request": "1" },
			data: {},
		});
		const body = (await response.json()) as {
			data: { events: { items: Array<{ data: Record<string, unknown> }> } };
		};
		expect(body.data.events.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ data: expect.objectContaining({ type: "media-uploaded" }) }),
			]),
		);
	});

	test("records comment moderation and email hooks from real admin workflows", async ({
		admin,
		page,
		request,
		serverInfo,
	}) => {
		const authorName = `Sandbox commenter ${crypto.randomUUID()}`;
		const comment = await request.post(
			`${serverInfo.baseUrl}/_emdash/api/comments/posts/${serverInfo.contentIds.posts[0]}`,
			{
				headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
				data: {
					body: "Created to cross the sandbox hook pipeline",
					authorName,
					authorEmail: "sandbox-comment@example.test",
				},
			},
		);
		expect(comment.status(), await comment.text()).toBe(201);

		await admin.goto("/comments");
		await admin.waitForLoading();
		const row = page.locator("tr", { hasText: authorName });
		await expect(row).toBeVisible();
		await row.getByRole("button", { name: "Approve" }).click();
		await expect(row).toBeHidden();

		const selectEmailProvider = await page.request.put(
			"/_emdash/api/admin/hooks/exclusive/email:deliver",
			{
				headers: { "X-EmDash-Request": "1" },
				data: { pluginId: "marketplace-test" },
			},
		);
		expect(selectEmailProvider.status(), await selectEmailProvider.text()).toBe(200);
		await admin.goto("/settings/email");
		await admin.waitForLoading();
		await expect(page.getByText("Email provider active", { exact: true })).toBeVisible();
		await expect(page.getByText("marketplace-test", { exact: true }).first()).toBeVisible();
		await page.getByRole("textbox", { name: "Recipient email" }).fill("recipient@example.test");
		await page.getByRole("button", { name: "Send Test" }).click();
		await expect(
			page.getByText("Test email sent to recipient@example.test", { exact: true }),
		).toBeVisible();

		const response = await page.request.post("/_emdash/api/plugins/marketplace-test/events-list", {
			headers: { "X-EmDash-Request": "1" },
			data: {},
		});
		const body = (await response.json()) as {
			data: { events: { items: Array<{ data: Record<string, unknown> }> } };
		};
		const eventTypes = body.data.events.items.map((item) => item.data.type);
		expect(eventTypes).toEqual(
			expect.arrayContaining([
				"comment-before-create",
				"comment-created",
				"comment-moderated",
				"email-before-send",
				"email-deliver",
				"email-after-send",
			]),
		);
	});
});
