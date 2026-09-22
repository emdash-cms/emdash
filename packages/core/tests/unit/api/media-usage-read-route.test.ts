import { Role, type RoleLevel } from "@emdash-cms/auth";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleMediaUsageDetails } from "../../../src/api/handlers/media-usage.js";
import {
	mediaUsageDetailsQuery,
	mediaUsageDetailsResponseSchema,
} from "../../../src/api/schemas/index.js";
import { injectCoreRoutes } from "../../../src/astro/integration/routes.js";
import * as usageRoute from "../../../src/astro/routes/api/media/[id]/usage.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import { MediaRepository, type MediaItem } from "../../../src/database/repositories/media.js";
import type { Database as DatabaseSchema } from "../../../src/database/types.js";
import {
	CONTENT_MEDIA_USAGE_ADAPTER_ID,
	CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
} from "../../../src/media/usage/content-refresh.js";
import { CONTENT_SOURCE_SCHEMA_VERSION } from "../../../src/media/usage/content-snapshots.js";
import {
	buildContentMediaUsageSourceKey,
	type MediaUsageContentSourceVariant,
} from "../../../src/media/usage/source-key.js";

type RouteContext = Parameters<typeof usageRoute.GET>[0];

interface SuccessBody<T> {
	data: T;
}

interface ErrorBody {
	error: { code: string; message: string };
}

describe("media usage detail schemas", () => {
	it("defaults and validates entry-group pagination", () => {
		expect(mediaUsageDetailsQuery.parse({})).toEqual({ limit: 50 });
		expect(mediaUsageDetailsQuery.parse({ limit: "100", cursor: "cursor" })).toEqual({
			limit: 100,
			cursor: "cursor",
		});
		for (const input of [
			{ limit: "0" },
			{ limit: "101" },
			{ limit: "1.5" },
			{ cursor: "" },
			{ cursor: "x".repeat(2049) },
		]) {
			expect(mediaUsageDetailsQuery.safeParse(input).success).toBe(false);
		}
	});
});

describe("media usage details handler and route", () => {
	let sqlite: Database.Database;
	let db: Kysely<DatabaseSchema>;
	let queries: string[];
	let usedMedia: MediaItem;
	let unreferencedMedia: MediaItem;

	beforeEach(async () => {
		queries = [];
		sqlite = new Database(":memory:");
		db = new Kysely<DatabaseSchema>({
			dialect: new SqliteDialect({ database: sqlite }),
			log(event) {
				if (event.level === "query") queries.push(event.query.sql);
			},
		});
		await runMigrations(db);

		const mediaRepository = new MediaRepository(db);
		usedMedia = await mediaRepository.create({
			filename: "used.png",
			mimeType: "image/png",
			storageKey: "used.png",
		});
		unreferencedMedia = await mediaRepository.create({
			filename: "unreferenced.png",
			mimeType: "image/png",
			storageKey: "unreferenced.png",
		});

		await db
			.insertInto("_emdash_collections")
			.values([
				{ id: "collection-pages", slug: "pages", label: "Pages", has_seo: 0 },
				{ id: "collection-posts", slug: "posts", label: "Posts", has_seo: 0 },
			])
			.execute();
		const usageRepository = new MediaUsageRepository(db);
		for (const scopeKey of ["pages", "posts"]) {
			await usageRepository.upsertIndexStatus({
				adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
				scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
				scopeKey,
				status: "complete",
				schemaVersion: CONTENT_SOURCE_SCHEMA_VERSION,
			});
		}

		await usageRepository.replaceSource(
			contentSource("entry-page", "columns", {
				collectionSlug: "pages",
				contentTitle: "Page title",
				contentSlug: "page-slug",
				contentStatus: "draft",
			}),
			[occurrence("hero", "hero", "image_field", usedMedia.id)],
		);
		await usageRepository.replaceSource(
			contentSource("entry-post", "columns", {
				contentTitle: "Columns title",
				contentSlug: "columns-slug",
				contentStatus: "published",
			}),
			[
				occurrence("hero", "hero", "image_field", usedMedia.id),
				occurrence("body", "body.file", "file_field", usedMedia.id, 1),
			],
		);
		const overlay = contentSource("entry-post", "draft_overlay", {
			contentTitle: null,
			contentSlug: "overlay-slug",
			locale: "fr",
			contentStatus: "scheduled",
			contentScheduledAt: "2026-08-01T00:00:00.000Z",
			contentDeletedAt: "2026-07-01T00:00:00.000Z",
		});
		await usageRepository.replaceSource(overlay, [
			occurrence("content", "content[0]", "portable_text_image", usedMedia.id),
			occurrence("future", "future.path", "image_field", usedMedia.id, 2),
		]);
		await db
			.updateTable("_emdash_media_usage")
			.set({ reference_type: "future_reference_type" })
			.where("source_key", "=", overlay.sourceKey)
			.where("field_slug", "=", "future")
			.execute();
		queries = [];
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await db.destroy();
	});

	it("registers a GET-only local-media usage route", () => {
		const routes: Array<{ pattern: string; entrypoint: string }> = [];
		injectCoreRoutes((route) => routes.push(route));
		const matches = routes.filter((route) => route.pattern === "/_emdash/api/media/[id]/usage");

		expect(matches).toHaveLength(1);
		expect(matches[0]?.entrypoint).toContain("api/media/_id_/usage");
		expect(usageRoute.GET).toBeTypeOf("function");
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
			expect(usageRoute).not.toHaveProperty(method);
		}
	});

	it("maps preferred metadata, conservative deletion, and narrow nested DTOs", async () => {
		const result = await handleMediaUsageDetails(db, usedMedia.id, { limit: 10 });

		expect(result).toEqual({
			success: true,
			data: {
				items: [
					{
						collection: "pages",
						contentId: "entry-page",
						title: "Page title",
						slug: "page-slug",
						locale: "en",
						status: "draft",
						scheduledAt: null,
						deletedAt: null,
						sources: [
							{
								variant: "columns",
								occurrences: [
									{
										fieldSlug: "hero",
										fieldPath: "hero",
										occurrenceIndex: 0,
										referenceType: "image_field",
									},
								],
							},
						],
					},
					{
						collection: "posts",
						contentId: "entry-post",
						title: null,
						slug: "overlay-slug",
						locale: "fr",
						status: "scheduled",
						scheduledAt: "2026-08-01T00:00:00.000Z",
						deletedAt: "2026-07-01T00:00:00.000Z",
						sources: [
							{
								variant: "columns",
								occurrences: [
									{
										fieldSlug: "body",
										fieldPath: "body.file",
										occurrenceIndex: 1,
										referenceType: "file_field",
									},
									{
										fieldSlug: "hero",
										fieldPath: "hero",
										occurrenceIndex: 0,
										referenceType: "image_field",
									},
								],
							},
							{
								variant: "draft_overlay",
								occurrences: [
									{
										fieldSlug: "content",
										fieldPath: "content[0]",
										occurrenceIndex: 0,
										referenceType: "portable_text_image",
									},
									{
										fieldSlug: "future",
										fieldPath: "future.path",
										occurrenceIndex: 2,
										referenceType: "unknown",
									},
								],
							},
						],
					},
				],
				coverage: { scope: "all_content_collections", status: "complete" },
			},
		});
		if (!result.success) throw new Error("Expected media usage details");
		expect(mediaUsageDetailsResponseSchema.parse(result.data)).toEqual(result.data);
		expect(queries).toHaveLength(3);
		const serialized = JSON.stringify(result);
		for (const forbidden of [
			"sourceKey",
			"generation",
			"revisionId",
			"translationGroup",
			"providerAssetId",
			"sourceCompleteness",
			"lastErrorCode",
		]) {
			expect(serialized).not.toContain(`"${forbidden}"`);
		}
		expect(serialized).not.toContain("count");
	});

	it("returns empty details plus coverage for an existing unreferenced media item", async () => {
		const result = await handleMediaUsageDetails(db, unreferencedMedia.id, {});

		expect(result).toEqual({
			success: true,
			data: {
				items: [],
				coverage: { scope: "all_content_collections", status: "complete" },
			},
		});
		expect(queries).toHaveLength(3);
	});

	it("returns NOT_FOUND before coverage or grouped usage reads", async () => {
		const result = await handleMediaUsageDetails(db, "missing-media", {});

		expect(result).toEqual({
			success: false,
			error: { code: "NOT_FOUND", message: "Media item not found: missing-media" },
		});
		expect(queries).toHaveLength(1);
		expect(queries[0]).not.toContain("_emdash_media_usage");
	});

	it("maps malformed cursors to INVALID_CURSOR", async () => {
		const result = await handleMediaUsageDetails(db, usedMedia.id, { cursor: "not-a-cursor" });

		expect(result).toEqual(
			expect.objectContaining({
				success: false,
				error: expect.objectContaining({ code: "INVALID_CURSOR" }),
			}),
		);
		expect(queries).toHaveLength(2);
	});

	it("returns generic read errors without leaking database failures", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await db.schema.dropTable("_emdash_media_usage").execute();
		queries = [];

		const result = await handleMediaUsageDetails(db, usedMedia.id, {});

		expect(result).toEqual({
			success: false,
			error: { code: "MEDIA_USAGE_READ_ERROR", message: "Failed to read media usage" },
		});
		expect(JSON.stringify(result)).not.toContain("no such table");
		expect(errorSpy).toHaveBeenCalledOnce();
	});

	it("pages entry groups through the route within three queries per page", async () => {
		const firstResponse = await invokeRoute({
			id: usedMedia.id,
			query: "?limit=1",
			role: Role.CONTRIBUTOR,
		});
		const first = await readSuccess<{
			items: Array<{ collection: string; contentId: string }>;
			nextCursor?: string;
		}>(firstResponse);

		expect(first.items).toEqual([
			expect.objectContaining({ collection: "pages", contentId: "entry-page" }),
		]);
		expect(first.nextCursor).toBeTypeOf("string");
		expect(queries).toHaveLength(3);
		queries = [];

		const secondResponse = await invokeRoute({
			id: usedMedia.id,
			query: `?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
			role: Role.CONTRIBUTOR,
		});
		const second = await readSuccess<{
			items: Array<{ collection: string; contentId: string }>;
			nextCursor?: string;
		}>(secondResponse);

		expect(second.items).toEqual([
			expect.objectContaining({ collection: "posts", contentId: "entry-post" }),
		]);
		expect(second.nextCursor).toBeUndefined();
		expect(queries).toHaveLength(3);
	});

	it.each([
		["missing ID", undefined, "", Role.CONTRIBUTOR, undefined, 400, "INVALID_REQUEST"],
		["empty cursor", "media", "?cursor=", Role.CONTRIBUTOR, undefined, 400, "VALIDATION_ERROR"],
	] as const)(
		"returns stable validation errors for %s",
		async (_name, id, query, role, tokenScopes, status, code) => {
			const response = await invokeRoute({ id, query, role, tokenScopes });

			expect(response.status).toBe(status);
			expect((await response.json()) as ErrorBody).toEqual(
				expect.objectContaining({ error: expect.objectContaining({ code }) }),
			);
			expect(queries).toHaveLength(0);
		},
	);

	it("returns INVALID_CURSOR for an authorized malformed cursor", async () => {
		const response = await invokeRoute({
			id: usedMedia.id,
			query: "?cursor=not-a-cursor",
			role: Role.CONTRIBUTOR,
		});

		expect(response.status).toBe(400);
		expect((await response.json()) as ErrorBody).toEqual(
			expect.objectContaining({ error: expect.objectContaining({ code: "INVALID_CURSOR" }) }),
		);
	});

	it.each([
		["anonymous caller", null, undefined, 401, "UNAUTHORIZED"],
		["subscriber session", Role.SUBSCRIBER, undefined, 403, "FORBIDDEN"],
		["media-read token", Role.CONTRIBUTOR, ["media:read"], 403, "INSUFFICIENT_SCOPE"],
	] as const)(
		"denies a %s before input validation or database reads",
		async (_name, role, tokenScopes, status, code) => {
			const response = await invokeRoute({
				id: "missing-media",
				query: "?cursor=not-a-cursor",
				role,
				tokenScopes,
			});

			expect(response.status).toBe(status);
			expect((await response.json()) as ErrorBody).toEqual(
				expect.objectContaining({ error: expect.objectContaining({ code }) }),
			);
			expect(queries).toHaveLength(0);
		},
	);

	it("returns NOT_CONFIGURED after authorization", async () => {
		const request = new Request(`http://localhost/_emdash/api/media/${usedMedia.id}/usage`);
		const response = await usageRoute.GET({
			params: { id: usedMedia.id },
			request,
			locals: { emdash: {}, user: { id: "user-1", role: Role.CONTRIBUTOR } },
		} as RouteContext);

		expect(response.status).toBe(500);
		expect((await response.json()) as ErrorBody).toEqual(
			expect.objectContaining({ error: expect.objectContaining({ code: "NOT_CONFIGURED" }) }),
		);
	});

	async function invokeRoute(input: {
		id?: string;
		query: string;
		role: RoleLevel | null;
		tokenScopes?: readonly string[];
	}): Promise<Response> {
		const request = new Request(
			`http://localhost/_emdash/api/media/${input.id ?? "missing"}/usage${input.query}`,
		);
		return usageRoute.GET({
			params: { id: input.id },
			request,
			locals: {
				emdash: { db },
				user: input.role === null ? null : { id: "user-1", role: input.role },
				tokenScopes: input.tokenScopes ? [...input.tokenScopes] : undefined,
			},
		} as RouteContext) as Promise<Response>;
	}
});

async function readSuccess<T>(response: Response): Promise<T> {
	return ((await response.json()) as SuccessBody<T>).data;
}

function contentSource(
	contentId: string,
	variant: MediaUsageContentSourceVariant,
	overrides: Partial<Parameters<MediaUsageRepository["replaceSource"]>[0]> = {},
): Parameters<MediaUsageRepository["replaceSource"]>[0] {
	const collectionSlug = overrides.collectionSlug ?? "posts";
	return {
		sourceKey: buildContentMediaUsageSourceKey({
			collectionSlug,
			contentId,
			sourceVariant: variant,
		}),
		sourceType: "content",
		collectionSlug,
		contentId,
		sourceVariant: variant,
		locale: "en",
		translationGroup: `tg-${contentId}`,
		contentSlug: `slug-${contentId}`,
		contentTitle: `Title ${contentId}`,
		contentStatus: variant === "columns" ? "published" : "draft",
		...overrides,
	};
}

function occurrence(
	fieldSlug: string,
	fieldPath: string,
	referenceType: "image_field" | "file_field" | "portable_text_image",
	mediaId: string,
	occurrenceIndex = 0,
): Parameters<MediaUsageRepository["replaceSource"]>[1][number] {
	return {
		fieldSlug,
		fieldPath,
		occurrenceIndex,
		referenceType,
		mediaId,
		provider: "local",
		providerAssetId: mediaId,
	};
}
