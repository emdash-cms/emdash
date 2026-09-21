import { createDialect } from "@emdash-cms/cloudflare/db/d1";
import { CloudflareSandboxRunner } from "@emdash-cms/cloudflare/sandbox";
import { env } from "cloudflare:workers";
import { OptionsRepository, type Database, type PluginManifest, type SandboxOptions } from "emdash";
import { Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createPluginRuntimeTestHost,
	createPluginTestHost,
	type PluginRuntimeTestHost,
	type PluginTestHost,
} from "../src/index.js";

let host: PluginTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("runtime plugin test host", () => {
	let runtimeHost: PluginRuntimeTestHost | undefined;

	afterEach(async () => {
		await runtimeHost?.dispose();
		runtimeHost = undefined;
	});

	it("exercises declared raw routes through core and Worker Loader", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0xff, 0, 13, 10, 128]);
		const response = await runtimeHost.actions.routes.request("raw-download", {
			method: "POST",
			rawBody: bytes,
		});
		expect(response.status).toBe(202);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);

		const headers = await runtimeHost.actions.routes.request("declared-headers", {
			method: "POST",
			headers: {
				"x-signature": "sha256=test",
				"x-hidden": "secret",
				cookie: "session=secret",
			},
		});
		expect(await headers.json()).toEqual({
			success: true,
			data: { signature: "sha256=test", hidden: "missing" },
		});

		const disallowed = await runtimeHost.actions.routes.request("raw-download", {
			method: "GET",
		});
		expect(disallowed.status).toBe(405);
		expect(disallowed.headers.get("allow")).toBe("POST");
	});

	it("parses multipart fields and files through the runtime host", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		const form = new FormData();
		form.append("title", "Report");
		form.append("attachment", new File([new Uint8Array([0, 255])], "report.bin"));
		const response = await runtimeHost.actions.routes.request("raw-form", {
			method: "POST",
			rawBody: form,
		});
		expect(await response.json()).toEqual({
			success: true,
			data: {
				entries: [
					{ name: "title", kind: "text", value: "Report" },
					{
						name: "attachment",
						kind: "file",
						filename: "report.bin",
						contentType: "application/octet-stream",
						bytes: [0, 255],
					},
				],
			},
		});
	});

	it("runs content actions through EmDashRuntime and preserves state across a cold restart", async () => {
		runtimeHost = await createPluginRuntimeTestHost({
			site: { url: "https://example.test", locale: "en", trailingSlash: "never" },
			i18n: { defaultLocale: "en", locales: ["en", "fr"] },
		});
		await expect(runtimeHost.transport.invokeRoute("site-info")).resolves.toEqual({
			name: "EmDash plugin test site",
			url: "https://example.test",
			locale: "en",
			trailingSlash: "never",
		});
		await runtimeHost.fixtures.collection({
			slug: "posts",
			label: "Posts",
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});

		const created = await runtimeHost.actions.content.create("posts", {
			data: { title: "Original" },
		});
		if (!created.success) throw new Error(created.error.message);
		const contentId = created.data.item.id;
		expect(created).toMatchObject({
			success: true,
			data: { item: { data: { title: "Original [sandbox]" } } },
		});
		await expect(runtimeHost.inspect.content.get("posts", contentId)).resolves.toMatchObject({
			id: contentId,
			data: { title: "Original [sandbox]" },
		});

		const before = (await runtimeHost.transport.invokeRoute("isolate-id")) as {
			isolateId: string;
		};
		await runtimeHost.fixtures.plugin.kv("restart-proof", { persisted: true });
		const uploaded = await runtimeHost.actions.media.upload({
			filename: "restart.png",
			contentType: "image/png",
			base64:
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
		});
		if (!uploaded.success) throw new Error(uploaded.error.message);
		await runtimeHost.restart();
		const after = (await runtimeHost.transport.invokeRoute("isolate-id")) as {
			isolateId: string;
		};
		expect(after.isolateId).not.toBe(before.isolateId);
		await expect(runtimeHost.inspect.content.get("posts", contentId)).resolves.toMatchObject({
			id: contentId,
		});
		await expect(runtimeHost.inspect.kv.get("restart-proof")).resolves.toEqual({ persisted: true });
		await expect(runtimeHost.inspect.media(uploaded.data.item.id)).resolves.toMatchObject({
			success: true,
			data: { item: { filename: "checked-restart.png" } },
		});
		await expect(
			runtimeHost.actions.content.update("posts", contentId, {
				data: { title: "Restarted" },
			}),
		).resolves.toMatchObject({
			success: true,
			data: { item: { data: { title: "Restarted [sandbox]" } } },
		});
	});

	it("discovers schema, content identity, translations, public URLs, and revisions through Worker Loader", async () => {
		runtimeHost = await createPluginRuntimeTestHost({
			site: { url: "https://example.test", locale: "en", trailingSlash: "always" },
			i18n: { defaultLocale: "en", locales: ["en", "fr"] },
		});
		await runtimeHost.fixtures.collection({
			slug: "posts",
			label: "Posts",
			urlPattern: "/journal/{slug}",
			fields: [{ slug: "title", label: "Title", type: "string", indexed: true }],
		});
		const english = await runtimeHost.fixtures.content("posts", {
			id: "post-en",
			slug: "hello",
			status: "published",
			locale: "en",
			authorId: "author-1",
			data: { title: "Hello" },
		});
		await runtimeHost.fixtures.content("posts", {
			id: "post-fr",
			slug: "bonjour",
			status: "draft",
			locale: "fr",
			translationOf: english.id,
			data: { title: "Bonjour" },
		});
		const revision = await runtimeHost.fixtures.revision("posts", english.id, {
			title: "Removed history",
		});

		const result = (await runtimeHost.transport.invokeRoute("content-discovery", {
			id: english.id,
		})) as Record<string, any>;
		expect(result.schema).toMatchObject({
			slug: "posts",
			fields: [expect.objectContaining({ slug: "title", indexed: true })],
		});
		expect(result.schema).not.toHaveProperty("id");
		expect(result.item).toMatchObject({
			id: english.id,
			authorId: "author-1",
			translationGroup: english.translationGroup,
			version: 1,
		});
		expect(result.translations.translations).toEqual([
			expect.objectContaining({ id: "post-en", locale: "en" }),
			expect.objectContaining({ id: "post-fr", locale: "fr" }),
		]);
		expect(result.publicUrl).toBe("https://example.test/journal/hello/");
		expect(result.revisions).toEqual([
			expect.objectContaining({ data: { title: "Removed history" } }),
		]);
		await runtimeHost.actions.content.trash("posts", english.id);
		await expect(
			runtimeHost.transport.invokeRoute("revision-discovery", {
				id: english.id,
				revisionId: revision.id,
			}),
		).resolves.toEqual({ list: [], item: null });
	});

	it("creates a translation through the runtime with shared fields, bylines, and taxonomies", async () => {
		runtimeHost = await createPluginRuntimeTestHost({
			i18n: { defaultLocale: "en", locales: ["en", "fr"] },
		});
		await runtimeHost.fixtures.collection({
			slug: "posts",
			label: "Posts",
			fields: [
				{ slug: "title", label: "Title", type: "string" },
				{ slug: "sku", label: "SKU", type: "string", translatable: false },
			],
		});
		const byline = await runtimeHost.fixtures.byline({
			slug: "ada",
			displayName: "Ada Lovelace",
			locale: "en",
		});
		await runtimeHost.fixtures.taxonomy({
			name: "tags",
			slug: "news",
			label: "News",
			locale: "en",
		});
		const source = await runtimeHost.actions.content.create("posts", {
			data: { title: "Hello", sku: "SKU-1" },
			locale: "en",
			bylines: [{ bylineId: byline.id, roleLabel: "Writer" }],
			taxonomies: { tags: ["news"] },
		});
		if (!source.success) throw new Error(source.error.message);
		await vi.waitFor(async () => {
			await expect(
				runtimeHost!.inspect.storage.get("events", source.data.item.id),
			).resolves.toMatchObject({ type: "saved" });
		});

		const translated = (await runtimeHost.transport.invokeRoute("content-translation-create", {
			translationOf: source.data.item.id,
			locale: "fr",
			data: { title: "Bonjour", sku: "IGNORED" },
		})) as { id: string; locale: string; translationGroup: string; data: Record<string, unknown> };

		expect(translated).toMatchObject({
			locale: "fr",
			translationGroup: source.data.item.translationGroup,
			data: { title: "Bonjour [sandbox]", sku: "SKU-1" },
		});
		await expect(runtimeHost.inspect.content.bylines("posts", translated.id)).resolves.toEqual([
			expect.objectContaining({ roleLabel: "Writer" }),
		]);
		await expect(
			runtimeHost.inspect.content.terms("posts", translated.id, "tags", "en"),
		).resolves.toEqual([expect.objectContaining({ slug: "news" })]);
		await expect(
			runtimeHost.transport.invokeRoute("content-translation-error", {
				translationOf: source.data.item.id,
				locale: "fr",
			}),
		).resolves.toMatchObject({ name: "CONFLICT", code: "CONFLICT" });
		await expect(
			runtimeHost.transport.invokeRoute("content-translation-error", {
				translationOf: "missing",
				locale: "fr",
			}),
		).resolves.toMatchObject({ name: "NOT_FOUND", code: "NOT_FOUND" });
		await expect(
			runtimeHost.transport.invokeRoute("content-translation-error", {
				translationOf: source.data.item.id,
				locale: "not_configured",
			}),
		).resolves.toMatchObject({ name: "VALIDATION_ERROR", code: "VALIDATION_ERROR" });
		await expect(
			runtimeHost.transport.invokeRoute("content-save-rejection"),
		).resolves.toMatchObject({ name: "SAVE_REJECTED", code: "SAVE_REJECTED" });
	});

	it("does not re-enter content save hooks for content created inside a save hook", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		await runtimeHost.fixtures.collection({
			slug: "posts",
			label: "Posts",
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});

		const result = await runtimeHost.actions.content.create("posts", {
			data: { title: "Original", createCompanion: true },
		});
		expect(result).toMatchObject({
			success: true,
			data: { item: { data: { title: "Original [sandbox]" } } },
		});
		if (!result.success) throw new Error(result.error.message);
		await expect(runtimeHost.inspect.content.list("posts")).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ data: { title: "Original [sandbox]" } }),
				expect.objectContaining({ data: { title: "Companion" } }),
			]),
		);
		await vi.waitFor(async () => {
			await expect(
				runtimeHost!.inspect.storage.get("events", result.data.item.id),
			).resolves.toMatchObject({ type: "saved" });
		});
	});

	it("runs taxonomy mutations through the host dispatcher and Worker Loader bridge", async () => {
		runtimeHost = await createPluginRuntimeTestHost({
			i18n: { defaultLocale: "en", locales: ["en", "fr"] },
		});
		await runtimeHost.fixtures.collection({
			slug: "posts",
			label: "Posts",
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});
		await runtimeHost.fixtures.taxonomyDefinition({
			name: "category",
			label: "Categories",
			labelSingular: "Category",
			hierarchical: true,
			collections: ["posts"],
		});
		const news = await runtimeHost.fixtures.taxonomy({
			name: "category",
			label: "News",
			slug: "news",
		});
		const reviews = await runtimeHost.fixtures.taxonomy({
			name: "category",
			label: "Reviews",
			slug: "reviews",
		});
		const content = await runtimeHost.fixtures.content("posts", { data: { title: "Post" } });
		const admin = await runtimeHost.fixtures.user({ email: "taxonomy@example.com", role: "admin" });
		const request = (name: string, body: unknown) =>
			runtimeHost!.actions.routes.request(name, {
				user: admin,
				headers: { "X-EmDash-Request": "1" },
				body,
			});

		const [first, second] = await Promise.all([
			request("taxonomy-add", { entryId: content.id, termIds: [news.id] }),
			request("taxonomy-add", { entryId: content.id, termIds: [reviews.id] }),
		]);
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		await expect(
			runtimeHost.inspect.content.terms("posts", content.id, "category", "en"),
		).resolves.toMatchObject([{ id: news.id }, { id: reviews.id }]);

		const created = await request("taxonomy-create", { taxonomy: "category", label: "Guides" });
		expect(created.status).toBe(200);
		expect(await created.json()).toMatchObject({ data: { slug: "guides", taxonomy: "category" } });

		expect(
			(await request("taxonomy-remove", { entryId: content.id, termIds: [news.id] })).status,
		).toBe(200);
		expect(
			(await request("taxonomy-remove", { entryId: content.id, termIds: [news.id] })).status,
		).toBe(200);
		await expect(
			runtimeHost.inspect.content.terms("posts", content.id, "category", "en"),
		).resolves.toMatchObject([{ id: reviews.id }]);
	});

	it("uses the production route dispatcher for authorization, CSRF, and cache policy", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		const publicResponse = await runtimeHost.actions.routes.request("isolate-id", {
			method: "GET",
		});
		expect(publicResponse.status).toBe(200);
		expect(publicResponse.headers.get("Cache-Control")).toBe("public, max-age=60");

		const unauthorized = await runtimeHost.actions.routes.request("private-user");
		expect(unauthorized.status).toBe(401);

		const user = await runtimeHost.fixtures.user({
			email: "editor@example.com",
			name: "Editor",
			role: "editor",
		});
		const missingCsrf = await runtimeHost.actions.routes.request("private-user", { user });
		expect(missingCsrf.status).toBe(403);
		const subscriber = await runtimeHost.fixtures.user({
			email: "subscriber@example.com",
			role: "subscriber",
		});
		const forbidden = await runtimeHost.actions.routes.request("private-user", {
			user: subscriber,
			headers: { "X-EmDash-Request": "1" },
		});
		expect(forbidden.status).toBe(403);
		const insufficientScope = await runtimeHost.actions.routes.request("private-user", {
			user,
			tokenScopes: ["content:read"],
		});
		expect(insufficientScope.status).toBe(403);
		const tokenAllowed = await runtimeHost.actions.routes.request("private-user", {
			user,
			tokenScopes: ["admin"],
		});
		expect(tokenAllowed.status).toBe(200);
		const allowed = await runtimeHost.actions.routes.request("private-user", {
			user,
			headers: { "X-EmDash-Request": "1" },
		});
		expect(allowed.status).toBe(200);
		await expect(allowed.json()).resolves.toMatchObject({ data: { userId: user.id } });
	});

	it("updates generated secret settings through the runtime host without storing plaintext", async () => {
		const oldKey = "emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
		const newKey = "emdash_enc_v1_EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
		vi.stubEnv("EMDASH_ENCRYPTION_KEY", oldKey);
		runtimeHost = await createPluginRuntimeTestHost();
		const updated = await runtimeHost.actions.plugin.updateSettings({
			apiKey: "old-runtime-host-secret",
		});
		expect(updated).toMatchObject({
			success: true,
			data: { secretsSet: { apiKey: true } },
		});
		const oldEnvelope = await runtimeHost.inspect.settings.raw<{ kid: string }>("apiKey");
		expect(oldEnvelope).toMatchObject({ v: 1, kid: expect.any(String) });
		expect(JSON.stringify(oldEnvelope)).not.toContain("old-runtime-host-secret");

		vi.stubEnv("EMDASH_ENCRYPTION_KEY", `${newKey},${oldKey}`);
		await runtimeHost.restart();
		await expect(runtimeHost.transport.invokeRoute("secret-value")).resolves.toEqual({
			viaSettings: "old-runtime-host-secret",
			viaCompatibilityAlias: "old-runtime-host-secret",
		});

		await runtimeHost.actions.plugin.updateSettings({ apiKey: "rotated-runtime-host-secret" });
		const newEnvelope = await runtimeHost.inspect.settings.raw<{
			v: 1;
			kid: string;
			iv: string;
			ciphertext: string;
		}>("apiKey");
		expect(newEnvelope?.kid).not.toBe(oldEnvelope?.kid);
		expect(JSON.stringify(newEnvelope)).not.toContain("rotated-runtime-host-secret");

		vi.stubEnv("EMDASH_ENCRYPTION_KEY", newKey);
		await runtimeHost.restart();
		await expect(runtimeHost.transport.invokeRoute("secret-value")).resolves.toEqual({
			viaSettings: "rotated-runtime-host-secret",
			viaCompatibilityAlias: "rotated-runtime-host-secret",
		});

		await runtimeHost.fixtures.plugin.setting("apiKey", {
			...newEnvelope,
			ciphertext: `${newEnvelope?.ciphertext[0] === "A" ? "B" : "A"}${newEnvelope?.ciphertext.slice(1)}`,
		});
		const tamperedRead = await runtimeHost.transport
			.invokeRoute("secret-value")
			.catch((error: unknown) => error);
		expect(String(tamperedRead)).toContain("could not be decrypted");
		expect(String(tamperedRead)).not.toContain("rotated-runtime-host-secret");
	});

	it("manages redirects through the runtime, Worker Loader, and plugin bridge", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		expect(runtimeHost.manifest.declaredAccess).toMatchObject({
			redirects: { read: {}, write: {} },
		});
		const admin = await runtimeHost.fixtures.user({
			email: "redirect-admin@example.com",
			role: "admin",
		});
		await runtimeHost.fixtures.redirect({
			source: "/automatic-old",
			destination: "/automatic-new",
			auto: true,
		});
		await runtimeHost.fixtures.redirect({
			source: "/old/[slug]",
			destination: "/new/[slug]",
		});
		const request = async <T>(body: Record<string, unknown>): Promise<T> => {
			const response = await runtimeHost!.actions.routes.request("redirects", {
				user: admin,
				headers: { "X-EmDash-Request": "1" },
				body,
			});
			expect(response.status).toBe(200);
			const payload = (await response.json()) as { data: T };
			return payload.data;
		};

		const automatic = await request<{ items: Array<{ auto: boolean; source: string }> }>({
			operation: "list",
			options: { auto: true, limit: 1 },
		});
		expect(automatic.items).toEqual([
			expect.objectContaining({ auto: true, source: "/automatic-old" }),
		]);

		const created = await request<{
			redirect: { id: string; source: string; destination: string; auto: boolean };
			_rev: string;
		}>({
			operation: "create",
			redirect: { source: "/legacy", destination: "/current" },
		});
		expect(created).toMatchObject({
			redirect: { source: "/legacy", destination: "/current", auto: false },
		});
		expect(created._rev).not.toContain(created.redirect.id);

		const concurrent = await Promise.all([
			request<{ redirect?: { source: string }; error?: { code: string } }>({
				operation: "create",
				redirect: { source: "/concurrent", destination: "/first" },
			}),
			request<{ redirect?: { source: string }; error?: { code: string } }>({
				operation: "create",
				redirect: { source: "/concurrent", destination: "/second" },
			}),
		]);
		expect(concurrent.filter((result) => result.redirect)).toHaveLength(1);
		expect(concurrent.filter((result) => result.error)).toHaveLength(1);
		expect(
			(await runtimeHost.inspect.redirects()).filter(
				(redirect) => redirect.source === "/concurrent",
			),
		).toHaveLength(1);

		const blockedMarker = await request<{ error: { code: string } }>({
			operation: "create",
			redirect: { source: "/forged", destination: "/target", auto: true },
		});
		expect(blockedMarker.error.code).toBe("VALIDATION_ERROR");

		const updated = await request<typeof created>({
			operation: "update",
			id: created.redirect.id,
			redirect: { destination: "/latest", _rev: created._rev },
		});
		expect(updated.redirect.destination).toBe("/latest");
		expect(updated._rev).not.toBe(created._rev);

		const stale = await request<{ error: { code: string } }>({
			operation: "update",
			id: created.redirect.id,
			redirect: { destination: "/lost", _rev: created._rev },
		});
		expect(stale.error.code).toBe("CONFLICT");

		await runtimeHost.restart();
		const readAfterRestart = await request<typeof created>({
			operation: "get",
			id: created.redirect.id,
		});
		expect(readAfterRestart.redirect.destination).toBe("/latest");

		await expect(runtimeHost.inspect.redirects()).resolves.toHaveLength(4);
		await expect(
			request<{ deleted: boolean }>({
				operation: "delete",
				id: created.redirect.id,
				_rev: readAfterRestart._rev,
			}),
		).resolves.toEqual({ deleted: true });
		await expect(runtimeHost.inspect.redirects()).resolves.toHaveLength(3);
		await expect(runtimeHost.inspect.redirects()).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ source: "/automatic-old", auto: true }),
				expect.objectContaining({ source: "/concurrent", auto: false }),
				expect.objectContaining({ source: "/old/[slug]", isPattern: true }),
			]),
		);
	});

	it("intercepts binary HTTP through the runtime and Worker Loader boundary", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		const admin = await runtimeHost.fixtures.user({
			email: "http-admin@example.com",
			role: "admin",
		});
		const firstUrl = "https://api.example.com/first";
		const secondUrl = "https://api.example.com/second";
		const firstBytes = new Uint8Array([0, 255, 195, 40]);
		const secondBytes = new Uint8Array([137, 80, 78, 71]);
		await runtimeHost.http.respond(
			firstUrl,
			new Response(firstBytes, {
				status: 206,
				statusText: "Partial Content",
				headers: { "content-type": "application/octet-stream" },
			}),
		);
		await runtimeHost.http.respond(
			secondUrl,
			new Response(secondBytes, {
				status: 200,
				headers: { "content-type": "image/png" },
			}),
		);

		const results = await Promise.all(
			[firstUrl, secondUrl].map(async (url) => {
				const response = await runtimeHost!.actions.routes.request("http-roundtrip", {
					user: admin,
					headers: { "X-EmDash-Request": "1" },
					body: { url },
				});
				expect(response.status).toBe(200);
				return response.json() as Promise<{ data: Record<string, unknown> }>;
			}),
		);
		const first = results[0];
		const second = results[1];
		if (!first || !second) throw new Error("Expected both HTTP route results");
		expect(first.data).toMatchObject({
			status: 206,
			statusText: "Partial Content",
			url: firstUrl,
			redirected: false,
			contentType: "application/octet-stream",
			bytes: [...firstBytes],
			cloneBytes: [...firstBytes],
		});
		expect(second.data).toMatchObject({
			status: 200,
			url: secondUrl,
			contentType: "image/png",
			bytes: [...secondBytes],
			cloneBytes: [...secondBytes],
		});
		expect(runtimeHost.http.requests()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ url: firstUrl, method: "POST", body: firstBytes }),
				expect.objectContaining({ url: secondUrl, method: "POST", body: firstBytes }),
			]),
		);
	});

	it("runs lifecycle, media, comment, scheduler, and email journeys through the isolate", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		await runtimeHost.fixtures.collection({
			slug: "posts",
			label: "Posts",
			commentsEnabled: true,
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});
		await runtimeHost.fixtures.content("posts", {
			id: "published-post",
			status: "published",
			data: { title: "Published" },
		});
		const admin = await runtimeHost.fixtures.user({
			email: "admin@example.com",
			name: "Admin",
			role: "admin",
		});

		const due = "2030-01-02T03:04:05.000Z";
		await runtimeHost.actions.routes.request("schedule-once", {
			user: admin,
			headers: { "X-EmDash-Request": "1" },
			body: { at: due },
		});
		await runtimeHost.actions.plugin.deactivate();
		await expect(runtimeHost.inspect.scheduledTasks()).resolves.toContainEqual(
			expect.objectContaining({ name: "runtime-test", enabled: 0 }),
		);
		await runtimeHost.actions.plugin.activate();
		await expect(runtimeHost.inspect.pluginState()).resolves.toMatchObject({
			pluginId: runtimeHost.manifest.id,
			status: "active",
		});
		await expect(
			runtimeHost.inspect.storage
				.list<{ type: string }>("lifecycle")
				.then((entries) => entries.map((entry) => entry.data.type)),
		).resolves.toEqual(["deactivate", "activate"]);

		const media = await runtimeHost.actions.media.upload({
			filename: "pixel.png",
			contentType: "image/png",
			base64:
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
		});
		expect(media.success).toBe(true);
		if (!media.success) throw new Error(media.error.message);
		expect(media.data.item.filename).toBe("checked-pixel.png");
		expect(media.data.item.size).toBe(69);

		const submitted = await runtimeHost.actions.comments.submit({
			collection: "posts",
			contentId: "published-post",
			authorName: "Reader",
			authorEmail: "reader@example.com",
			body: "Useful post",
		});
		expect(submitted.status).toBe(201);
		const submittedBody = (await submitted.json()) as { data: { id: string; status: string } };
		expect(submittedBody.data.status).toBe("pending");
		await runtimeHost.actions.comments.moderate(submittedBody.data.id, "approved", admin);

		await runtimeHost.actions.routes.request("schedule-once", {
			user: admin,
			headers: { "X-EmDash-Request": "1" },
			body: { at: due },
		});
		await expect(runtimeHost.inspect.scheduledTasks()).resolves.toContainEqual(
			expect.objectContaining({ name: "runtime-test", nextRunAt: due }),
		);
		runtimeHost.scheduled.setTime("2030-01-02T03:04:06.000Z");
		await expect(runtimeHost.scheduled.run()).resolves.toMatchObject({ processed: 1 });
		await expect(runtimeHost.inspect.scheduledTasks()).resolves.toEqual([]);

		await runtimeHost.actions.routes.request("send-email", {
			user: admin,
			headers: { "X-EmDash-Request": "1" },
		});
		await expect(runtimeHost.inspect.email()).resolves.toContainEqual(
			expect.objectContaining({ to: "author@example.com", subject: "Runtime host" }),
		);
		const events = await runtimeHost.inspect.storage.list("events");
		expect(events).toContainEqual(
			expect.objectContaining({
				data: expect.objectContaining({ type: "media-uploaded", size: 69 }),
			}),
		);
		expect(events.map((entry) => (entry.data as { type: string }).type)).toEqual(
			expect.arrayContaining(["media-uploaded", "comment-created", "comment-moderated", "cron"]),
		);
	});

	it("reads binary fixtures and updates metadata through the production Worker Loader bridge", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		const bytes = new Uint8Array([0, 255, 17, 42]);
		const fixture = await runtimeHost.fixtures.media({
			filename: "private-scan.bin",
			mimeType: "application/octet-stream",
			bytes,
			reportedSize: 1,
			alt: "Original alt",
			contentHash: "sha1:private-scan",
			authorId: "private-author",
		});

		await expect(
			runtimeHost.transport.invokeRoute("media-read-bytes", {
				id: fixture.id,
				maxBytes: 3,
			}),
		).rejects.toThrow("Media exceeds the requested 3-byte limit");
		await expect(
			runtimeHost.transport.invokeRoute("media-read-bytes", {
				id: fixture.id,
				maxBytes: 4,
			}),
		).resolves.toEqual({
			bytes: [0, 255, 17, 42],
			filename: "private-scan.bin",
			mimeType: "application/octet-stream",
			size: 4,
			contentHash: "sha1:private-scan",
		});
		await expect(runtimeHost.inspect.mediaBytes(fixture.id)).resolves.toEqual(bytes);

		const metadata = await runtimeHost.transport.invokeRoute("media-get", { id: fixture.id });
		expect(metadata).not.toHaveProperty("storageKey");
		expect(metadata).not.toHaveProperty("authorId");
		expect(metadata).not.toHaveProperty("contentHash");
		await expect(
			runtimeHost.transport.invokeRoute("media-update-alt", {
				id: fixture.id,
				alt: "Scanned document",
			}),
		).resolves.toMatchObject({ id: fixture.id, alt: "Scanned document" });
		await expect(runtimeHost.inspect.media(fixture.id)).resolves.toMatchObject({
			success: true,
			data: { item: { alt: "Scanned document", contentHash: "sha1:private-scan" } },
		});

		const pending = await runtimeHost.fixtures.media({
			filename: "pending.bin",
			mimeType: "application/octet-stream",
			bytes,
			status: "pending",
		});
		await expect(
			runtimeHost.transport.invokeRoute("media-get", { id: pending.id }),
		).resolves.toBeNull();
		await expect(
			runtimeHost.transport.invokeRoute("media-read-bytes", { id: pending.id }),
		).rejects.toThrow("Media item is not ready or does not exist");
	});

	it("reads and moderates comments through the runtime-owned Worker Loader bridge", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		await runtimeHost.fixtures.collection({
			slug: "posts",
			label: "Posts",
			commentsEnabled: true,
		});
		const author = await runtimeHost.fixtures.user({
			email: "author@example.com",
			name: "Author",
			role: "author",
			emailVerified: true,
		});
		await runtimeHost.fixtures.content("posts", {
			id: "commented-post",
			status: "published",
			authorId: author.id,
			data: {},
		});
		const pending = await runtimeHost.fixtures.comment({
			collection: "posts",
			contentId: "commented-post",
			authorName: "Reader",
			authorEmail: "reader@example.com",
			body: "Needs review",
			status: "pending",
			ipHash: "sha256:reader",
			userAgent: "Comment client/1.0",
			moderationMetadata: { attemptRecursiveModeration: true },
		});
		await runtimeHost.fixtures.comment({
			collection: "posts",
			contentId: "commented-post",
			authorName: "Spammer",
			authorEmail: "spam@example.com",
			body: "Spam",
			status: "spam",
		});
		const slow = await runtimeHost.fixtures.comment({
			collection: "posts",
			contentId: "commented-post",
			authorName: "Concurrent reader",
			authorEmail: "concurrent@example.com",
			body: "Concurrent moderation",
			status: "pending",
			moderationMetadata: { slowModeration: true },
		});
		await runtimeHost.fixtures.comment({
			collection: "posts",
			contentId: "commented-post",
			authorName: "Deleted",
			authorEmail: "deleted@example.com",
			body: "Trashed",
			status: "trash",
		});

		const admin = await runtimeHost.fixtures.user({
			email: "admin@example.com",
			role: "admin",
		});
		const readResponse = await runtimeHost.actions.routes.request("comments-read", {
			user: admin,
			headers: { "X-EmDash-Request": "1" },
			body: { id: pending.id },
		});
		expect(readResponse.status).toBe(200);
		const readBody = (await readResponse.json()) as {
			data: {
				comment: Record<string, unknown>;
				page: { items: unknown[]; hasMore: boolean };
				count: number;
			};
		};
		expect(readBody.data.comment).toMatchObject({
			authorEmail: "reader@example.com",
			body: "Needs review",
			ipHash: "sha256:reader",
			userAgent: "Comment client/1.0",
			moderationMetadata: { attemptRecursiveModeration: true },
		});
		expect(readBody.data.comment).not.toHaveProperty("authorUserId");
		expect(readBody.data.page).toMatchObject({ hasMore: true });
		expect(readBody.data.page.items).toHaveLength(1);
		expect(readBody.data.count).toBe(3);

		const invalidResponse = await runtimeHost.actions.routes.request("comments-invalid-status", {
			user: admin,
			headers: { "X-EmDash-Request": "1" },
			body: { id: pending.id },
		});
		await expect(invalidResponse.json()).resolves.toMatchObject({
			data: {
				rejected: true,
				message: "status must be one of: approved, pending, spam",
			},
		});
		await expect(runtimeHost.inspect.comments()).resolves.toContainEqual(
			expect.objectContaining({ id: pending.id, status: "pending" }),
		);
		await expect(
			runtimeHost.actions.comments.moderateAsPlugin(pending.id, "trash" as never, "pending"),
		).rejects.toThrow("status must be one of: approved, pending, spam");
		await expect(runtimeHost.inspect.comments()).resolves.toContainEqual(
			expect.objectContaining({ id: pending.id, status: "pending" }),
		);

		const approveResponse = await runtimeHost.actions.routes.request("comments-moderate", {
			user: admin,
			headers: { "X-EmDash-Request": "1" },
			body: { id: pending.id, status: "approved", expectedStatus: "pending" },
		});
		expect(approveResponse.status).toBe(200);
		await expect(approveResponse.json()).resolves.toMatchObject({
			data: { id: pending.id, status: "approved" },
		});
		await expect(runtimeHost.inspect.email()).resolves.toHaveLength(1);
		const moderationEvents = (await runtimeHost.inspect.storage.list("events")).filter(
			(entry) =>
				typeof entry.data === "object" &&
				entry.data !== null &&
				"type" in entry.data &&
				entry.data.type === "comment-moderated",
		);
		expect(moderationEvents).toHaveLength(1);
		expect(moderationEvents[0]?.data).toMatchObject({
			status: "approved",
			origin: { source: "plugin", pluginId: runtimeHost.manifest.id },
		});
		expect(await runtimeHost.inspect.storage.list("events")).toContainEqual(
			expect.objectContaining({
				data: expect.objectContaining({ type: "comment-recursion-blocked" }),
			}),
		);

		const staleResponse = await runtimeHost.actions.routes.request("comments-moderate", {
			user: admin,
			headers: { "X-EmDash-Request": "1" },
			body: { id: pending.id, status: "spam", expectedStatus: "pending" },
		});
		expect(staleResponse.status).toBe(200);
		await expect(staleResponse.json()).resolves.toMatchObject({
			data: {
				error: { code: "COMMENT_STATUS_CONFLICT", currentStatus: "approved" },
			},
		});
		await expect(runtimeHost.inspect.comments()).resolves.toContainEqual(
			expect.objectContaining({ id: pending.id, status: "approved" }),
		);

		const approvingSlow = runtimeHost.actions.routes.request("comments-moderate", {
			user: admin,
			headers: { "X-EmDash-Request": "1" },
			body: { id: slow.id, status: "approved", expectedStatus: "pending" },
		});
		let hookStarted = false;
		for (let attempt = 0; attempt < 50; attempt++) {
			const events = await runtimeHost.inspect.storage.list("events");
			hookStarted = events.some(
				(entry) =>
					typeof entry.data === "object" &&
					entry.data !== null &&
					"type" in entry.data &&
					entry.data.type === "comment-moderated" &&
					"commentId" in entry.data &&
					entry.data.commentId === slow.id,
			);
			if (hookStarted) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(hookStarted).toBe(true);
		const overlapping = await runtimeHost.actions.routes.request("comments-moderate", {
			user: admin,
			headers: { "X-EmDash-Request": "1" },
			body: { id: slow.id, status: "spam", expectedStatus: "pending" },
		});
		await expect(overlapping.json()).resolves.toMatchObject({
			data: {
				error: { code: "COMMENT_STATUS_CONFLICT", currentStatus: "approved" },
			},
		});
		await expect(approvingSlow.then((response) => response.json())).resolves.toMatchObject({
			data: { id: slow.id, status: "approved" },
		});
	});

	it("uses one controlled clock for scheduled content and one cron batch", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		const admin = await runtimeHost.fixtures.user({
			email: "scheduler@example.com",
			role: "admin",
		});
		await runtimeHost.fixtures.collection({
			slug: "posts",
			label: "Posts",
			routable: true,
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});
		const content = await runtimeHost.fixtures.content("posts", {
			slug: "scheduled-post",
			data: { title: "Scheduled" },
		});
		const due = "2030-01-02T03:04:05.000Z";
		const scheduled = await runtimeHost.actions.content.schedule("posts", content.id, due);
		if (!scheduled.success) throw new Error(scheduled.error.message);

		for (let index = 0; index < 11; index++) {
			await runtimeHost.actions.routes.request("schedule-once", {
				user: admin,
				headers: { "X-EmDash-Request": "1" },
				body: { at: due, name: `task-${index}` },
			});
		}

		runtimeHost.scheduled.setTime("2030-01-02T03:04:06.000Z");
		await expect(runtimeHost.scheduled.run()).resolves.toEqual({
			processed: 10,
			published: [{ collection: "posts", id: content.id }],
		});
		await expect(runtimeHost.inspect.scheduledTasks()).resolves.toHaveLength(1);
	});

	it("enforces publication policy through Worker Loader for every action origin", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		await runtimeHost.fixtures.collection({
			slug: "posts",
			label: "Posts",
			routable: true,
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});
		const editor = await runtimeHost.fixtures.user({
			email: "policy-editor@example.com",
			role: "editor",
		});
		const content = await runtimeHost.fixtures.content("posts", {
			slug: "policy-post",
			data: { title: "Policy post" },
		});

		const origins = [
			{ origin: { source: "api" as const }, actor: { id: editor.id, role: editor.role } },
			{ origin: { source: "mcp" as const }, actor: { id: editor.id, role: editor.role } },
			{
				origin: { source: "visual-editor" as const },
				actor: { id: editor.id, role: editor.role },
			},
			{ origin: { source: "plugin" as const, pluginId: "review-cycle" } },
			{ origin: { source: "system" as const } },
		];
		let revision: string | undefined;
		for (const action of origins) {
			const result = await runtimeHost.actions.content.publish("posts", content.id, {
				_rev: revision,
				...action,
			});
			if (!result.success) throw new Error(result.error.message);
			revision = result.data._rev;
		}

		const beforeStale = await runtimeHost.inspect.storage.list("events");
		await expect(
			runtimeHost.actions.content.publish("posts", content.id, {
				_rev: "stale-revision",
				origin: { source: "api" },
				actor: { id: editor.id, role: editor.role },
			}),
		).resolves.toMatchObject({ success: false, error: { code: "CONFLICT" } });
		expect(await runtimeHost.inspect.storage.list("events")).toHaveLength(beforeStale.length);

		await runtimeHost.fixtures.plugin.kv(
			"policy:content:beforeUnpublish",
			"Legal approval is required.",
		);
		await expect(
			runtimeHost.actions.content.unpublish("posts", content.id, {
				_rev: revision,
				origin: { source: "mcp" },
				actor: { id: editor.id, role: editor.role },
			}),
		).resolves.toMatchObject({
			success: false,
			error: { code: "UNPUBLISH_REJECTED", message: "Legal approval is required." },
		});
		await expect(runtimeHost.inspect.content.get("posts", content.id)).resolves.toMatchObject({
			status: "published",
		});

		const scheduledContent = await runtimeHost.fixtures.content("posts", {
			slug: "scheduled-policy-post",
			data: { title: "Scheduled policy post" },
		});
		const due = "2030-01-02T03:04:05.000Z";
		const scheduled = await runtimeHost.actions.content.schedule(
			"posts",
			scheduledContent.id,
			due,
			{ origin: { source: "system" } },
		);
		if (!scheduled.success) throw new Error(scheduled.error.message);
		await runtimeHost.fixtures.plugin.kv(
			"policy:content:beforePublish",
			"A reviewer must approve this entry.",
		);
		runtimeHost.scheduled.setTime("2030-01-02T03:04:06.000Z");
		await expect(runtimeHost.scheduled.run()).resolves.toMatchObject({ published: [] });
		await expect(
			runtimeHost.inspect.content.get("posts", scheduledContent.id),
		).resolves.toMatchObject({ status: "draft", scheduledAt: null });
		await expect(runtimeHost.inspect.scheduledPolicyRejections()).resolves.toContainEqual(
			expect.objectContaining({
				collection: "posts",
				id: scheduledContent.id,
				pluginId: runtimeHost.manifest.id,
				reason: "A reviewer must approve this entry.",
			}),
		);
		await runtimeHost.fixtures.plugin.kv("policy:content:beforePublish", null);
		const rescheduled = await runtimeHost.actions.content.schedule(
			"posts",
			scheduledContent.id,
			"2031-01-01T00:00:00.000Z",
			{ origin: { source: "api" }, actor: { id: editor.id, role: editor.role } },
		);
		if (!rescheduled.success) throw new Error(rescheduled.error.message);
		await expect(runtimeHost.inspect.scheduledPolicyRejections()).resolves.toEqual([]);

		const retryableContent = await runtimeHost.fixtures.content("posts", {
			slug: "retryable-policy-post",
			data: { title: "Retryable policy post" },
		});
		const retryable = await runtimeHost.actions.content.schedule(
			"posts",
			retryableContent.id,
			"2030-01-03T03:04:05.000Z",
			{ origin: { source: "system" } },
		);
		if (!retryable.success) throw new Error(retryable.error.message);
		await runtimeHost.fixtures.plugin.kv("policy:content:beforePublish", "__invalid__");
		runtimeHost.scheduled.setTime("2030-01-03T03:04:06.000Z");
		await expect(runtimeHost.scheduled.run()).resolves.toMatchObject({ published: [] });
		await expect(
			runtimeHost.inspect.content.get("posts", retryableContent.id),
		).resolves.toMatchObject({
			status: "scheduled",
			scheduledAt: "2030-01-03T03:04:05.000Z",
		});

		const policyEvents = (await runtimeHost.inspect.storage.list("events"))
			.map(
				(entry) =>
					entry.data as {
						type: string;
						hook?: string;
						origin?: { source: string };
						actor?: { source?: string };
					},
			)
			.filter((entry) => entry.type === "content-policy");
		expect(policyEvents.map((event) => event.origin?.source)).toEqual(
			expect.arrayContaining(["api", "mcp", "visual-editor", "plugin", "scheduler", "system"]),
		);
		expect(
			policyEvents.find((event) => event.origin?.source === "visual-editor")?.actor,
		).toMatchObject({ source: "visual-editor" });
		expect(policyEvents.find((event) => event.origin?.source === "plugin")?.actor).toBeUndefined();
	});

	it("runs versioned publication and restore actions through Worker Loader", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		await runtimeHost.fixtures.collection({
			slug: "posts",
			label: "Posts",
			routable: true,
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});
		const admin = await runtimeHost.fixtures.user({
			email: "publication-actions@example.com",
			role: "admin",
		});
		const content = await runtimeHost.fixtures.content("posts", {
			slug: "publication-actions",
			data: { title: "Publication actions" },
		});
		const invoke = async (body: Record<string, unknown>) => {
			const response = await runtimeHost!.actions.routes.request("content-action", {
				user: admin,
				headers: { "X-EmDash-Request": "1" },
				body,
			});
			expect(response.status).toBe(200);
			const json: unknown = await response.json();
			if (
				typeof json !== "object" ||
				json === null ||
				!("data" in json) ||
				typeof json.data !== "object" ||
				json.data === null
			) {
				throw new Error("Expected versioned action response");
			}
			return json.data as {
				item: { id: string; status: string; scheduledAt?: string | null };
				_rev: string;
			};
		};

		let current = await invoke({
			action: "getVersioned",
			collection: "posts",
			id: content.id,
		});
		await runtimeHost.fixtures.plugin.kv("policy:reenter-publish", true);
		const reentrant = await runtimeHost.actions.routes.request("content-action", {
			user: admin,
			headers: { "X-EmDash-Request": "1" },
			body: {
				action: "publish",
				collection: "posts",
				id: "publication-actions",
				_rev: current._rev,
			},
		});
		expect(reentrant.status).toBe(200);
		await expect(reentrant.json()).resolves.toMatchObject({
			data: { actionError: { code: "PUBLISH_REJECTED" } },
		});
		await expect(runtimeHost.inspect.content.get("posts", content.id)).resolves.toMatchObject({
			status: "draft",
		});
		await expect(runtimeHost.inspect.storage.list("events")).resolves.toContainEqual(
			expect.objectContaining({
				data: expect.objectContaining({
					type: "content-action-rejected",
					code: "CONTENT_ACTION_REENTRANT",
				}),
			}),
		);
		await runtimeHost.fixtures.plugin.kv("policy:reenter-publish", false);
		current = await invoke({
			action: "publish",
			collection: "posts",
			id: content.id,
			_rev: current._rev,
		});
		expect(current.item.status).toBe("published");
		current = await invoke({
			action: "unpublish",
			collection: "posts",
			id: content.id,
			_rev: current._rev,
		});
		expect(current.item.status).toBe("draft");
		current = await invoke({
			action: "schedule",
			collection: "posts",
			id: content.id,
			scheduledAt: "2031-01-01T00:00:00.000Z",
			_rev: current._rev,
		});
		expect(current.item.scheduledAt).toBe("2031-01-01T00:00:00.000Z");
		current = await invoke({
			action: "unschedule",
			collection: "posts",
			id: content.id,
			_rev: current._rev,
		});
		expect(current.item.scheduledAt).toBeNull();

		await runtimeHost.actions.content.trash("posts", content.id);
		const trashed = await invoke({
			action: "getTrashedVersioned",
			collection: "posts",
			id: content.id,
		});
		const restored = await invoke({
			action: "restore",
			collection: "posts",
			id: content.id,
			_rev: trashed._rev,
		});
		expect(restored.item.id).toBe(content.id);
		await vi.waitFor(async () => {
			for (const action of ["publish", "unpublish", "schedule", "unschedule", "restore"]) {
				await expect(
					runtimeHost!.inspect.storage.get("events", `action:${action}:${content.id}`),
				).resolves.toMatchObject({ type: "content-action", action, contentId: content.id });
			}
		});
	});

	it("runs public comment policy and follows every content-list cursor", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		await runtimeHost.fixtures.collection({
			slug: "posts",
			label: "Posts",
			commentsEnabled: true,
			commentsClosedAfterDays: 1,
		});
		await runtimeHost.fixtures.content("posts", {
			id: "closed-post",
			status: "published",
			publishedAt: "2020-01-01T00:00:00.000Z",
			data: {},
		});

		const response = await runtimeHost.actions.comments.submit({
			collection: "posts",
			contentId: "closed-post",
			authorName: "Reader",
			authorEmail: "reader@example.com",
			body: "Too late",
		});
		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toMatchObject({ error: { code: "COMMENTS_CLOSED" } });

		for (let index = 0; index < 101; index++) {
			await runtimeHost.fixtures.content("posts", {
				id: `post-${String(index).padStart(3, "0")}`,
				data: {},
			});
		}
		await expect(runtimeHost.inspect.content.list("posts")).resolves.toHaveLength(102);
	});

	it("removes a timezone-less one-shot after it runs", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		const admin = await runtimeHost.fixtures.user({
			email: "local-scheduler@example.com",
			role: "admin",
		});
		await runtimeHost.actions.routes.request("schedule-once", {
			user: admin,
			headers: { "X-EmDash-Request": "1" },
			body: { at: "2030-01-02T03:04:05", name: "local-time" },
		});
		runtimeHost.scheduled.setTime("2030-01-02T03:04:06.000Z");
		await expect(runtimeHost.scheduled.run()).resolves.toMatchObject({ processed: 1 });
		await expect(runtimeHost.inspect.scheduledTasks()).resolves.toEqual([]);
	});

	it("uses the controlled clock to schedule and advance recurring cron tasks", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		const admin = await runtimeHost.fixtures.user({
			email: "recurring-scheduler@example.com",
			role: "admin",
		});
		runtimeHost.scheduled.setTime("2030-01-02T03:04:05.000Z");
		await runtimeHost.actions.routes.request("schedule-once", {
			user: admin,
			headers: { "X-EmDash-Request": "1" },
			body: { at: "@daily", name: "recurring" },
		});
		await expect(runtimeHost.inspect.scheduledTasks()).resolves.toContainEqual(
			expect.objectContaining({
				name: "recurring",
				nextRunAt: "2030-01-03T00:00:00.000Z",
			}),
		);

		runtimeHost.scheduled.setTime("2030-01-03T00:00:01.000Z");
		await expect(runtimeHost.scheduled.run()).resolves.toMatchObject({ processed: 1 });
		await expect(runtimeHost.inspect.scheduledTasks()).resolves.toContainEqual(
			expect.objectContaining({
				name: "recurring",
				nextRunAt: "2030-01-04T00:00:00.000Z",
			}),
		);
		await expect(runtimeHost.scheduled.run()).resolves.toMatchObject({ processed: 0 });
	});

	it("clears database and isolate state when disposed", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		await runtimeHost.fixtures.collection({ slug: "temporary", label: "Temporary" });
		await runtimeHost.dispose();
		runtimeHost = await createPluginRuntimeTestHost();
		await expect(runtimeHost.inspect.content.list("temporary")).rejects.toThrow();
	});

	it("loads validated Block Kit pages and widgets with host-attested locale context", async () => {
		runtimeHost = await createPluginRuntimeTestHost();

		const [pageResponse, widgetResponse] = await Promise.all([
			runtimeHost.admin.loadPage("/overview", { locale: "ar" }),
			runtimeHost.admin.loadWidget("status", { locale: "en" }),
		]);

		expect(pageResponse.blocks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "fields",
					fields: [
						{ label: "Surface", value: "admin-page" },
						{ label: "Locale", value: "ar" },
						{ label: "Direction", value: "rtl" },
					],
				}),
			]),
		);
		expect(widgetResponse.blocks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "fields",
					fields: [
						{ label: "Surface", value: "dashboard-widget" },
						{ label: "Locale", value: "en" },
						{ label: "Direction", value: "ltr" },
					],
				}),
			]),
		);
	});

	it("rejects undeclared UI surfaces and unsafe browser resources before rendering", async () => {
		runtimeHost = await createPluginRuntimeTestHost();

		await expect(runtimeHost.admin.loadPage("/undeclared")).rejects.toThrow(
			"Plugin admin page is not declared",
		);
		await expect(runtimeHost.admin.act("/overview", "unsafe-image")).rejects.toThrow(
			"INVALID_BLOCK_RESPONSE",
		);
		await expect(runtimeHost.admin.act("/overview", "oversized-response")).rejects.toThrow(
			"INVALID_BLOCK_RESPONSE",
		);
	});

	it("invokes saved-entry panels and actions with host-attested identity", async () => {
		runtimeHost = await createPluginRuntimeTestHost({
			i18n: { defaultLocale: "en", locales: ["en", "ar"] },
		});
		await runtimeHost.fixtures.collection({
			slug: "posts",
			label: "Posts",
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});
		const entry = await runtimeHost.fixtures.content("posts", {
			data: { title: "Saved entry" },
			locale: "en",
		});

		const panel = await runtimeHost.admin.loadEditorPanel("entry-context", "posts", entry.id, {
			locale: "ar",
			contentLocale: "en",
		});
		expect(panel.blocks[0]).toMatchObject({
			type: "fields",
			fields: [
				{ label: "Surface", value: "content-editor-panel" },
				{ label: "Extension", value: "entry-context" },
				{ label: "Collection", value: "posts" },
				{ label: "Entry", value: entry.id },
				{ label: "Content locale", value: "en" },
				{ label: "Version", value: expect.any(String) },
			],
		});
		await runtimeHost.actions.content.update("posts", entry.id, {
			data: { title: "Updated entry" },
			locale: "en",
		});
		const refreshedPanel = await runtimeHost.admin.loadEditorPanel(
			"entry-context",
			"posts",
			entry.id,
			{ locale: "ar", contentLocale: "en" },
		);
		expect(refreshedPanel.blocks[0]).toMatchObject({
			type: "fields",
			fields: expect.arrayContaining([{ label: "Version", value: "2" }]),
		});

		await expect(
			runtimeHost.admin.invokeEditorAction("refresh-entry", "posts", entry.id, {
				locale: "ar",
				contentLocale: "en",
			}),
		).resolves.toEqual({
			refresh: true,
			toast: { type: "success", message: `posts/${entry.id} refreshed` },
		});
		await expect(
			runtimeHost.admin.actEditorPanel("entry-context", "posts", entry.id, "invalid"),
		).rejects.toThrow("INVALID_BLOCK_RESPONSE");
		await expect(
			runtimeHost.admin.invokeEditorAction("invalid-action", "posts", entry.id),
		).rejects.toThrow("INVALID_EDITOR_ACTION_RESPONSE");
	});

	it("authorizes editor extensions against the saved entry owner", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		await runtimeHost.fixtures.collection({
			slug: "posts",
			label: "Posts",
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});
		const [owner, otherAuthor] = await Promise.all([
			runtimeHost.fixtures.user({ email: "owner@example.test", role: "author" }),
			runtimeHost.fixtures.user({ email: "other@example.test", role: "author" }),
		]);
		const entry = await runtimeHost.fixtures.content("posts", {
			data: { title: "Owned entry" },
			authorId: owner.id,
		});

		await expect(
			runtimeHost.admin.loadEditorPanel("entry-context", "posts", entry.id, { user: owner }),
		).resolves.toHaveProperty("blocks");
		await expect(
			runtimeHost.admin.loadEditorPanel("entry-context", "posts", entry.id, {
				user: otherAuthor,
			}),
		).rejects.toThrow("(403)");
		await expect(
			runtimeHost.admin.loadEditorPanel("missing", "posts", entry.id, { user: owner }),
		).rejects.toThrow("(404)");
		await expect(
			runtimeHost.admin.loadEditorPanel("entry-context", "pages", entry.id, { user: owner }),
		).rejects.toThrow("(404)");
	});
});

describe("plugin test host", () => {
	it("loads the built plugin through Worker Loader and persists host state", async () => {
		host = await createPluginTestHost();
		expect(host.manifest.routes).toContainEqual({
			name: "hello",
			public: true,
			cacheControl: "public, max-age=60",
		});
		expect(host.manifest.routes).toContainEqual({
			name: "content-count",
			permission: "content:read",
		});
		expect(host.manifest.admin.settingsSchema).toHaveProperty("enabled");
		expect(host.manifest.admin.fieldWidgets?.[0]).toMatchObject({ name: "event-picker" });
		expect(host.manifest.admin.editorPanels?.[0]).toMatchObject({
			id: "entry-context",
			route: "entry-context",
		});
		expect(host.manifest.admin.editorActions?.[0]).toMatchObject({
			id: "refresh-entry",
			route: "refresh-entry",
		});

		await expect(host.invokeRoute("hello")).resolves.toEqual({
			pluginId: host.manifest.id,
		});
		await expect(host.kv.get("last-route")).resolves.toBe("hello");

		await host.invokeHook("content:afterSave", {
			collection: "posts",
			content: { id: "post-1" },
		});
		await expect(host.storage("events").get("post-1")).resolves.toEqual({
			type: "saved",
			collection: "posts",
		});
	});

	it("uses a migrated D1 database for content bridge calls", async () => {
		host = await createPluginTestHost();
		await host.createCollection({
			slug: "posts",
			label: "Posts",
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});
		await host.seedContent("posts", [{ title: "First" }, { title: "Second" }]);

		await expect(host.invokeRoute("content-count")).resolves.toEqual({ count: 2 });
	});

	it("makes auto-generated admin settings visible inside the Worker Loader isolate", async () => {
		vi.stubEnv(
			"EMDASH_ENCRYPTION_KEY",
			"emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		);
		host = await createPluginTestHost();
		const db = new Kysely<Database>({
			dialect: createDialect({ binding: "DB", session: "disabled" }),
		});
		try {
			await new OptionsRepository(db).set(`plugin:${host.manifest.id}:settings:enabled`, false);
			await expect(host.invokeRoute("settings-value")).resolves.toEqual({ enabled: false });
			await expect(host.invokeRoute("settings-update", { enabled: true })).resolves.toEqual({
				enabled: true,
			});
			await expect(
				new OptionsRepository(db).get(`plugin:${host.manifest.id}:settings:enabled`),
			).resolves.toBe(true);
		} finally {
			await db.destroy();
		}
	});

	it("encrypts generated secrets before a Worker Loader plugin reads them", async () => {
		vi.stubEnv(
			"EMDASH_ENCRYPTION_KEY",
			"emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		);
		host = await createPluginTestHost();
		const db = new Kysely<Database>({
			dialect: createDialect({ binding: "DB", session: "disabled" }),
		});
		try {
			await new OptionsRepository(db).set(
				`plugin:${host.manifest.id}:settings:apiKey`,
				"legacy-secret",
			);
			await expect(host.invokeRoute("secret-value")).resolves.toEqual({
				viaSettings: "legacy-secret",
				viaCompatibilityAlias: "legacy-secret",
			});
			await expect(
				host.invokeRoute("secret-save", { apiKey: "encrypted-secret" }),
			).resolves.toEqual({ saved: true });
			const raw = await new OptionsRepository(db).get(`plugin:${host.manifest.id}:settings:apiKey`);
			expect(raw).toMatchObject({ v: 1, kid: expect.any(String) });
			expect(JSON.stringify(raw)).not.toContain("encrypted-secret");
			await expect(host.invokeRoute("secret-value")).resolves.toEqual({
				viaSettings: "encrypted-secret",
				viaCompatibilityAlias: "encrypted-secret",
			});
		} finally {
			await db.destroy();
		}
	});

	it("delivers a real host content event to the Worker Loader isolate", async () => {
		const bindings = env as unknown as {
			EMDASH_PLUGIN_CODE: string;
			EMDASH_PLUGIN_MANIFEST: string;
		};
		const manifest = JSON.parse(bindings.EMDASH_PLUGIN_MANIFEST) as PluginManifest;
		const runtimeModuleUrl = new URL("../../core/src/emdash-runtime.ts", import.meta.url).href;
		const { EmDashRuntime } = await import(/* @vite-ignore */ runtimeModuleUrl);
		const entry = {
			id: manifest.id,
			version: manifest.version,
			options: {},
			code: bindings.EMDASH_PLUGIN_CODE,
			capabilities: manifest.capabilities,
			allowedHosts: manifest.allowedHosts,
			storage: manifest.storage,
			hooks: manifest.hooks,
			routes: manifest.routes,
			settingsSchema: manifest.admin.settingsSchema,
			fieldWidgets: manifest.admin.fieldWidgets,
		};
		const deps = {
			config: {
				database: {
					entrypoint: `plugin-test-runtime-${crypto.randomUUID()}`,
					type: "sqlite" as const,
					config: { binding: "DB" },
				},
			},
			plugins: [],
			createDialect: () => createDialect({ binding: "DB", session: "disabled" }),
			createStorage: null,
			createScheduler: null,
			sandboxEnabled: true,
			sandboxedPluginEntries: [entry],
			createSandboxRunner: (options: SandboxOptions) => new CloudflareSandboxRunner(options),
		};
		const runtime = await EmDashRuntime.create(deps);
		try {
			await runtime.schemaRegistry.createCollection({
				slug: "posts",
				label: "Posts",
				labelSingular: "Post",
			});
			await runtime.schemaRegistry.createField("posts", {
				slug: "title",
				label: "Title",
				type: "string",
			});

			const result = await runtime.handleContentCreate("posts", {
				data: { title: "Original" },
			});
			expect(result).toMatchObject({
				success: true,
				data: { item: { data: { title: "Original [sandbox]" } } },
			});
		} finally {
			await runtime.getSandboxRunner()?.terminateAll();
			await runtime.stopCron();
		}
	});
});
