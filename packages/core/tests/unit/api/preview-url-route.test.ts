import { Role } from "@emdash-cms/auth";
import { LiveEntryNotFoundError } from "astro/content/runtime";
import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { handleContentCreate } from "../../../src/api/index.js";
import type { EmDashConfig } from "../../../src/astro/integration/runtime.js";
import { POST as previewUrl } from "../../../src/astro/routes/api/content/[collection]/[id]/preview-url.js";
import { resolveSecretsCached } from "../../../src/config/secrets.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import type { Database } from "../../../src/database/types.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { _resetAstroI18nCacheForTests } from "../../../src/i18n/resolve.js";
import { createHookPipeline } from "../../../src/plugins/hooks.js";
import type { ResolvedPlugin } from "../../../src/plugins/types.js";
import { parseContentId, verifyPreviewToken } from "../../../src/preview/index.js";
import { getEmDashEntry } from "../../../src/query.js";
import { runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

vi.mock("astro:content", async () => {
	const { emdashLoader } = await import("../../../src/loader.js");
	const loader = emdashLoader();
	return {
		getLiveEntry: async (
			_name: string,
			filter: Parameters<NonNullable<typeof loader.loadEntry>>[0]["filter"],
		) => {
			const result = await loader.loadEntry!({ filter });
			if (result === undefined) {
				return {
					entry: undefined,
					error: new LiveEntryNotFoundError(filter.type, filter.id),
				};
			}
			if ("error" in result) return { entry: undefined, error: result.error };
			return { entry: result, error: undefined, cacheHint: result.cacheHint };
		},
	};
});

/**
 * Regression: the preview-url endpoint used a hard-coded `/{collection}/{id}`
 * default, ignoring the collection's configured `url_pattern`. On any site
 * whose content is served at a custom permalink (e.g. `/blog/{slug}`) the
 * admin "Preview" button produced a link that 404'd. The sitemap and
 * "View published" links already resolve the same `url_pattern`; the preview
 * link must too. See discussion #1525 / PR #1526.
 */
describe("preview-url route — respects collection url_pattern", () => {
	let db: Kysely<Database>;
	let runtime: EmDashRuntime;

	function buildRuntime(config: EmDashConfig = {}, configuredPlugins: ResolvedPlugin[] = []) {
		const pipelineFactoryOptions = { db } as const;
		const hooks = createHookPipeline(configuredPlugins, pipelineFactoryOptions);
		const pipelineRef = { current: hooks };
		const runtimeDeps = {
			config,
			plugins: configuredPlugins,
			createDialect: () => {
				throw new Error("createDialect not used in this test");
			},
			createStorage: null,
			sandboxEnabled: false,
			sandboxedPluginEntries: [],
			createSandboxRunner: null,
		};

		return new EmDashRuntime({
			db,
			storage: null,
			configuredPlugins,
			sandboxedPlugins: new Map(),
			sandboxedPluginEntries: [],
			hooks,
			enabledPlugins: new Set(configuredPlugins.map((plugin) => plugin.id)),
			pluginStates: new Map(),
			config,
			mediaProviders: new Map(),
			mediaProviderEntries: [],
			cronExecutor: null,
			cronScheduler: null,
			emailPipeline: null,
			allPipelinePlugins: [...configuredPlugins],
			pipelineFactoryOptions,
			runtimeDeps,
			pipelineRef,
		});
	}

	const call = async (collection: string, id: string, body: Record<string, unknown> = {}) => {
		const request = new Request(
			`http://localhost/_emdash/api/content/${collection}/${id}/preview-url`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			},
		);
		const response = await previewUrl({
			params: { collection, id },
			request,
			locals: {
				emdash: {
					db,
					handleContentGet: runtime.handleContentGet.bind(runtime),
				},
				user: { id: "u1", role: Role.ADMIN },
			},
		} as unknown as Parameters<typeof previewUrl>[0]);
		return response;
	};

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		runtime = buildRuntime();
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		setI18nConfig(null);
		_resetAstroI18nCacheForTests();
		await teardownTestDatabase(db);
	});

	it("resolves the configured url_pattern into the preview link", async () => {
		await new SchemaRegistry(db).updateCollection("post", { urlPattern: "/blog/{slug}" });
		const created = await handleContentCreate(db, "post", {
			data: { title: "Hello World" },
		});
		const id = created.data!.item.id;

		const response = await call("post", id);
		expect(response.status).toBe(200);
		const { url } = (await response.json()).data as { url: string };

		expect(url.startsWith("/blog/hello-world?_preview=")).toBe(true);
		// The generic collection/id fallback must NOT leak through.
		expect(url.startsWith("/post/")).toBe(false);
	});

	it("falls back to /{collection}/{id} when no url_pattern is configured", async () => {
		const created = await handleContentCreate(db, "post", {
			data: { title: "No Pattern" },
		});
		const id = created.data!.item.id;

		const response = await call("post", id);
		expect(response.status).toBe(200);
		const { url } = (await response.json()).data as { url: string };

		expect(url.startsWith(`/post/${id}?_preview=`)).toBe(true);
	});

	it("lets an explicit pathPattern override the url_pattern", async () => {
		await new SchemaRegistry(db).updateCollection("post", { urlPattern: "/blog/{slug}" });
		const created = await handleContentCreate(db, "post", {
			data: { title: "Override Me" },
		});
		const id = created.data!.item.id;

		const response = await call("post", id, { pathPattern: "/custom/{id}" });
		expect(response.status).toBe(200);
		const { url } = (await response.json()).data as { url: string };

		expect(url.startsWith(`/custom/${id}?_preview=`)).toBe(true);
	});

	it("lets the EMDASH_PREVIEW_PATH_PATTERN env override win over the url_pattern", async () => {
		vi.stubEnv("EMDASH_PREVIEW_PATH_PATTERN", "/env/{id}");
		await new SchemaRegistry(db).updateCollection("post", { urlPattern: "/blog/{slug}" });
		const created = await handleContentCreate(db, "post", {
			data: { title: "Env Wins" },
		});
		const id = created.data!.item.id;

		const response = await call("post", id);
		expect(response.status).toBe(200);
		const { url } = (await response.json()).data as { url: string };

		expect(url.startsWith(`/env/${id}?_preview=`)).toBe(true);
		expect(url.startsWith("/blog/")).toBe(false);
	});

	it("prefixes the locale segment for a non-default-locale entry", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "de"], prefixDefaultLocale: false });
		_resetAstroI18nCacheForTests();
		await new SchemaRegistry(db).updateCollection("post", { urlPattern: "/blog/{slug}" });
		const created = await handleContentCreate(db, "post", {
			data: { title: "Hallo Welt" },
			locale: "de",
		});
		const id = created.data!.item.id;

		const response = await call("post", id);
		expect(response.status).toBe(200);
		const { url } = (await response.json()).data as { url: string };

		expect(url.startsWith("/de/blog/hallo-welt?_preview=")).toBe(true);
	});

	describe("staged draft slugs", () => {
		const states = [
			"draft",
			"published",
			"unpublished",
			"scheduled",
			"published+scheduled",
		] as const;

		it.each(states)("uses the staged slug for a %s entry", async (state) => {
			await new SchemaRegistry(db).updateCollection("post", { urlPattern: "/{slug}" });
			const created = await runtime.handleContentCreate("post", {
				data: { title: "Old" },
				slug: "old-slug",
			});
			expect(created.success).toBe(true);
			if (!created.success) return;
			let current = created.data;

			if (state === "published" || state === "unpublished" || state === "published+scheduled") {
				const published = await runtime.handleContentPublish("post", current.item.id);
				expect(published.success).toBe(true);
				if (!published.success) return;
				current = published.data;
			}
			if (state === "unpublished") {
				const unpublished = await runtime.handleContentUnpublish("post", current.item.id, {
					_rev: current._rev,
				});
				expect(unpublished.success).toBe(true);
				if (!unpublished.success) return;
				current = unpublished.data;
			}
			if (state === "scheduled" || state === "published+scheduled") {
				const scheduled = await runtime.handleContentSchedule(
					"post",
					current.item.id,
					"2099-01-01T00:00:00.000Z",
				);
				expect(scheduled.success).toBe(true);
				if (!scheduled.success) return;
				current = scheduled.data;
			}

			const updated = await runtime.handleContentUpdate("post", current.item.id, {
				data: { title: "New" },
				slug: "new-slug",
				_rev: current._rev,
			});
			expect(updated.success).toBe(true);
			if (!updated.success) return;

			const normal = await runtime.handleContentGet("post", current.item.id);
			expect(normal.data?.item.slug).toBe("old-slug");
			expect(normal.data?.item.draftRevisionId).toBeTruthy();

			const response = await call("post", current.item.id);
			expect(response.status).toBe(200);
			const { url } = (await response.json()).data as { url: string };
			expect(url.startsWith("/new-slug?_preview=")).toBe(true);
		});

		it("renders the staged draft from a preview URL requested by the row slug", async () => {
			await new SchemaRegistry(db).updateCollection("post", { urlPattern: "/blog/{slug}" });
			const created = await runtime.handleContentCreate("post", {
				data: { title: "Published title" },
				slug: "old-slug",
			});
			expect(created.success).toBe(true);
			if (!created.success) return;
			const published = await runtime.handleContentPublish("post", created.data.item.id);
			expect(published.success).toBe(true);
			if (!published.success) return;
			const updated = await runtime.handleContentUpdate("post", created.data.item.id, {
				data: { title: "Draft title" },
				slug: "new-slug",
				_rev: published.data._rev,
			});
			expect(updated.success).toBe(true);

			const response = await call("post", "old-slug");
			expect(response.status).toBe(200);
			const { url } = (await response.json()).data as { url: string };
			const resolvedUrl = new URL(url, "http://localhost");
			expect(resolvedUrl.pathname).toBe("/blog/new-slug");
			const { previewSecret } = await resolveSecretsCached(db);
			const token = await verifyPreviewToken({ url: resolvedUrl, secret: previewSecret });
			expect(token.valid).toBe(true);
			if (!token.valid) return;

			const result = await runWithContext(
				{ db, editMode: false, preview: parseContentId(token.payload.cid) },
				() => getEmDashEntry("post", resolvedUrl.pathname.slice("/blog/".length)),
			);
			expect(result.entry).toMatchObject({ data: { slug: "new-slug", title: "Draft title" } });
			expect(result.isPreview).toBe(true);
		});

		it.each([
			{ pattern: null, body: {}, path: "/post/old-slug" },
			{ pattern: "/blog/{slug}", body: { pathPattern: "/custom/{id}" }, path: "/custom/old-slug" },
		])(
			"retains the route slug in the fallback path and token at $path",
			async ({ pattern, body, path }) => {
				if (pattern) await new SchemaRegistry(db).updateCollection("post", { urlPattern: pattern });
				const created = await runtime.handleContentCreate("post", {
					data: { title: "Old" },
					slug: "old-slug",
				});
				expect(created.success).toBe(true);

				const response = await call("post", "old-slug", body);
				expect(response.status).toBe(200);
				const { url } = (await response.json()).data as { url: string };
				const resolvedUrl = new URL(url, "http://localhost");
				expect(resolvedUrl.pathname).toBe(path);
				const { previewSecret } = await resolveSecretsCached(db);
				const token = await verifyPreviewToken({ url: resolvedUrl, secret: previewSecret });
				expect(token.valid).toBe(true);
				if (!token.valid) return;
				const result = await runWithContext(
					{ db, editMode: false, preview: parseContentId(token.payload.cid) },
					() => getEmDashEntry("post", resolvedUrl.pathname.split("/").at(-1)!),
				);
				expect(result.entry).toMatchObject({ data: { slug: "old-slug", title: "Old" } });
				expect(result.isPreview).toBe(true);
			},
		);

		it("falls back to the row slug when the draft revision has no _slug", async () => {
			await new SchemaRegistry(db).updateCollection("post", { urlPattern: "/{slug}" });
			const created = await runtime.handleContentCreate("post", {
				data: { title: "Old" },
				slug: "row-slug",
			});
			expect(created.success).toBe(true);
			if (!created.success) return;

			const revision = await new RevisionRepository(db).create({
				collection: "post",
				entryId: created.data.item.id,
				data: { title: "Draft" },
			});
			await new ContentRepository(db).setDraftRevision("post", created.data.item.id, revision.id);

			const normal = await runtime.handleContentGet("post", created.data.item.id);
			expect(normal.success).toBe(true);
			if (!normal.success) return;
			expect(normal.data.item.slug).toBe("row-slug");

			const response = await call("post", created.data.item.id);
			expect(response.status).toBe(200);
			const { url } = (await response.json()).data as { url: string };
			expect(url.startsWith("/row-slug?_preview=")).toBe(true);
		});
	});
});
