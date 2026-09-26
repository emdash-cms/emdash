import type { APIResponse } from "@playwright/test";

import { expect, test } from "../fixtures";

const PLUGIN_ROUTE = "/_emdash/api/plugins/marketplace-test";

async function pluginData<T>(response: APIResponse): Promise<T> {
	const text = await response.text();
	expect(response.status(), text).toBe(200);
	return (JSON.parse(text) as { data: T }).data;
}

test.describe("Sandboxed plugin production boundaries", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test("routes content, schema, users, storage, KV, settings, and cron through the isolate", async ({
		page,
		serverInfo,
	}) => {
		const invoke = <T>(route: string, data: unknown = {}) =>
			page.request
				.post(`${PLUGIN_ROUTE}/${route}`, {
					headers: { "X-EmDash-Request": "1" },
					data,
				})
				.then(pluginData<T>);

		const discovery = await invoke<{
			schema: { slug: string };
			item: { id: string; data: { title: string } };
			revisions: unknown[];
		}>("content-discovery", { id: serverInfo.contentIds.posts[0] });
		expect(discovery).toMatchObject({
			schema: { slug: "posts" },
			item: { id: serverInfo.contentIds.posts[0], data: { title: "First Post" } },
		});
		expect(discovery.revisions.length).toBeGreaterThan(0);

		await expect(invoke("storage-exercise")).resolves.toMatchObject({
			exists: true,
			count: 3,
			staleApplied: false,
			removed: true,
			deletedMany: 2,
		});
		await expect(invoke("kv-exercise")).resolves.toMatchObject({
			plain: { ok: true },
			staleApplied: false,
			removed: true,
		});
		await expect(invoke("settings-exercise")).resolves.toMatchObject({
			current: { value: "second" },
			staleApplied: false,
			removed: true,
		});
		await expect(invoke("schema-exercise")).resolves.toMatchObject({
			posts: { slug: "posts" },
		});
		await expect(invoke("users-exercise")).resolves.toMatchObject({
			page: { items: [expect.objectContaining({ email: "dev@emdash.local" })] },
		});
		await expect(invoke("cron-exercise")).resolves.toMatchObject({
			scheduled: [expect.objectContaining({ name: "diagnostic" })],
			remaining: [],
		});
	});

	test("persists content, taxonomy, redirect, and media operations through host repositories", async ({
		page,
	}) => {
		const invoke = <T>(route: string, data: unknown = {}) =>
			page.request
				.post(`${PLUGIN_ROUTE}/${route}`, {
					headers: { "X-EmDash-Request": "1" },
					data,
				})
				.then(pluginData<T>);

		const created = await invoke<{ id: string }>("content-crud", {
			operation: "create",
			data: { title: `Sandbox route ${crypto.randomUUID()}` },
		});
		await expect(
			invoke("content-crud", { operation: "get", id: created.id }),
		).resolves.toMatchObject({ id: created.id });

		const term = await invoke<{ id: string }>("taxonomy-create", {
			taxonomy: "category",
			label: `Sandbox ${crypto.randomUUID()}`,
		});
		await expect(
			invoke("taxonomy-add", { entryId: created.id, termIds: [term.id] }),
		).resolves.toEqual([expect.objectContaining({ id: term.id })]);
		await expect(invoke("taxonomy-read", { entryId: created.id })).resolves.toMatchObject({
			assigned: [expect.objectContaining({ id: term.id })],
		});
		await expect(
			invoke("taxonomy-remove", { entryId: created.id, termIds: [term.id] }),
		).resolves.toEqual([]);

		const redirect = await invoke<{ redirect: { id: string }; _rev: string }>("redirects", {
			operation: "create",
			redirect: {
				source: `/sandbox-${crypto.randomUUID()}`,
				destination: "/",
				type: 302,
			},
		});
		await expect(
			invoke("redirects", { operation: "get", id: redirect.redirect.id }),
		).resolves.toMatchObject({ redirect: { id: redirect.redirect.id } });
		await expect(
			invoke("redirects", { operation: "delete", id: redirect.redirect.id, _rev: redirect._rev }),
		).resolves.toEqual({ deleted: true });

		const upload = await invoke<{ mediaId: string }>("media-exercise", { operation: "upload" });
		await expect(
			invoke("media-exercise", { operation: "metadata", id: upload.mediaId }),
		).resolves.toMatchObject({
			id: upload.mediaId,
			alt: "Fixture alt",
			focalX: 0.25,
			focalY: 0.75,
		});
		await expect(invoke("media-read-bytes", { id: upload.mediaId })).resolves.toMatchObject({
			mimeType: "application/pdf",
			bytes: [37, 80, 68, 70, 45, 49, 46, 55],
		});
		await expect(
			invoke("media-exercise", { operation: "delete", id: upload.mediaId }),
		).resolves.toEqual({ deleted: true });

		await expect(invoke("content-crud", { operation: "delete", id: created.id })).resolves.toEqual({
			deleted: true,
		});
	});

	test("enforces route parsing, binary transport, raw responses, methods, and headers", async ({
		page,
	}) => {
		const json = await page.request.post(`${PLUGIN_ROUTE}/body-json`, {
			data: { fixture: true },
		});
		await expect(json.json()).resolves.toMatchObject({ data: { input: { fixture: true } } });

		const text = await page.request.post(`${PLUGIN_ROUTE}/body-text`, {
			headers: { "Content-Type": "text/plain" },
			data: "sandbox",
		});
		await expect(text.json()).resolves.toMatchObject({ data: { text: "sandbox", length: 7 } });

		const bytes = new Uint8Array([0, 255, 1, 254]);
		const binary = await page.request.post(`${PLUGIN_ROUTE}/raw-download`, {
			headers: { "Content-Type": "application/octet-stream" },
			data: Buffer.from(bytes),
		});
		expect(binary.status()).toBe(202);
		expect(new Uint8Array(await binary.body())).toEqual(bytes);

		const raw = await page.request.get(`${PLUGIN_ROUTE}/raw-text`);
		expect(raw.headers()["content-type"]).toBe("text/plain; charset=utf-8");
		expect(await raw.text()).toBe("marketplace-test");

		const headers = await page.request.post(`${PLUGIN_ROUTE}/declared-headers`, {
			headers: { "x-signature": "signed", "x-hidden": "secret" },
		});
		await expect(headers.json()).resolves.toMatchObject({
			data: { signature: "signed", hidden: "missing" },
		});

		const rejected = await page.request.put(`${PLUGIN_ROUTE}/body-text`, {
			data: "no",
		});
		expect(rejected.status()).toBe(405);
		expect(rejected.headers().allow).toBe("POST");
	});

	test("keeps undeclared authority unavailable and renders the denial in the real admin", async ({
		admin,
		page,
	}) => {
		const response = await page.request.post(
			"/_emdash/api/plugins/sandbox-denied-test/authority-probe",
			{ headers: { "X-EmDash-Request": "1" }, data: {} },
		);
		const authority = (await response.json()) as { data: Record<string, string> };
		expect(Object.keys(authority.data).toSorted()).toEqual([
			"comments",
			"content",
			"media",
			"redirects",
			"schema",
			"taxonomies",
			"users",
		]);
		expect(Object.values(authority.data)).not.toContain("GRANTED");

		await admin.goto("/plugins/sandbox-denied-test/denials");
		await admin.waitForLoading();
		await expect(page.getByRole("heading", { name: "Denied authority probe" })).toBeVisible();
		const main = page.getByRole("main");
		await expect(main.getByText("Content", { exact: true })).toBeVisible();
		await expect(main.getByText("Media", { exact: true })).toBeVisible();
		await expect(main.getByText("Taxonomies", { exact: true })).toBeVisible();
		await expect(main.getByText("GRANTED", { exact: true })).toHaveCount(0);
	});

	test("contributes validated metadata to a real public page without trusted fragments", async ({
		page,
	}) => {
		await page.goto("/posts/first-post");
		await expect(page.locator('meta[name="emdash-plugin"]')).toHaveAttribute(
			"content",
			"marketplace-test",
		);
		const jsonLd = await page.locator('script[type="application/ld+json"]').allTextContents();
		expect(jsonLd.some((value) => value.includes('"@type":"WebPage"'))).toBe(true);
		await expect(
			page.getByText("This trusted-only contribution must never reach a sandboxed page."),
		).toHaveCount(0);
	});
});
