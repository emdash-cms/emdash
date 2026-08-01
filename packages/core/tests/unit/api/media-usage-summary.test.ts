import { Role, type RoleLevel } from "@emdash-cms/auth";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	aggregateMediaUsageCoverageStatus,
	handleMediaUsageSummaries,
} from "../../../src/api/handlers/media-usage.js";
import { handleMediaGet, handleMediaList } from "../../../src/api/handlers/media.js";
import {
	mediaGetQuery,
	mediaListQuery,
	mediaReadResponseSchema,
	mediaResponseSchema,
	mediaUsageSummarySchema,
} from "../../../src/api/schemas/index.js";
import { GET as listMedia } from "../../../src/astro/routes/api/media.js";
import { GET as getMediaItem } from "../../../src/astro/routes/api/media/[id].js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import { MediaRepository, type MediaItem } from "../../../src/database/repositories/media.js";
import type { Database as DatabaseSchema } from "../../../src/database/types.js";
import {
	CONTENT_MEDIA_USAGE_ADAPTER_ID,
	CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
} from "../../../src/media/usage/content-refresh.js";
import { CONTENT_SOURCE_SCHEMA_VERSION } from "../../../src/media/usage/content-snapshots.js";
import { buildContentMediaUsageSourceKey } from "../../../src/media/usage/source-key.js";

type ListRouteContext = Parameters<typeof listMedia>[0];
type GetRouteContext = Parameters<typeof getMediaItem>[0];

interface SuccessBody<T> {
	data: T;
}

interface ErrorBody {
	success: false;
	error: { code: string; message: string };
}

interface MediaListBodyItem extends MediaItem {
	url: string;
	usage?: {
		count: number | null;
		coverage: { scope: "all_content_collections"; status: string };
	};
}

interface MediaGetBodyItem extends MediaItem {
	usage?: MediaListBodyItem["usage"];
}

describe("media usage summary schemas", () => {
	it.each([mediaListQuery, mediaGetQuery])(
		"accepts only the exact includeUsage literal",
		(schema) => {
			expect(schema.parse({ includeUsage: "1" }).includeUsage).toBe("1");
			for (const includeUsage of ["0", "true", "false"]) {
				expect(schema.safeParse({ includeUsage }).success).toBe(false);
			}
		},
	);

	it("accepts every public coverage state and nullable counts", () => {
		for (const status of [
			"complete",
			"never",
			"running",
			"partial",
			"failed",
			"stale",
			"unknown",
		] as const) {
			expect(
				mediaUsageSummarySchema.parse({
					count: null,
					coverage: { scope: "all_content_collections", status },
				}),
			).toEqual({ count: null, coverage: { scope: "all_content_collections", status } });
		}
	});

	it("keeps usage off mutation response schemas", () => {
		const item = mediaItemFixture();
		const usage = {
			count: 0,
			coverage: { scope: "all_content_collections" as const, status: "complete" as const },
		};

		expect(mediaReadResponseSchema.parse({ item: { ...item, usage } }).item.usage).toEqual(usage);
		expect(mediaResponseSchema.parse({ item: { ...item, usage } }).item).not.toHaveProperty(
			"usage",
		);
	});
});

describe("media usage coverage aggregation", () => {
	const scope = (status: string | null, schemaVersion = CONTENT_SOURCE_SCHEMA_VERSION) => ({
		collectionSlug: "posts",
		status,
		schemaVersion: status === null ? null : schemaVersion,
	});

	it.each([
		["no collections", [], "complete"],
		["all complete", [scope("complete")], "complete"],
		["all missing", [scope(null), { ...scope(null), collectionSlug: "pages" }], "never"],
		["complete and missing", [scope("complete"), scope(null)], "partial"],
		["old complete", [scope("complete", CONTENT_SOURCE_SCHEMA_VERSION - 1)], "stale"],
		["unknown stored status", [scope("surprise")], "unknown"],
		["unknown before running", [scope("running"), scope("surprise")], "unknown"],
		["homogeneous running", [scope("running"), scope("running")], "running"],
		["running before stale", [scope("stale"), scope("running")], "running"],
		["homogeneous stale", [scope("stale"), scope("stale")], "stale"],
		["stale before partial", [scope("partial"), scope("stale")], "stale"],
		["homogeneous partial", [scope("partial"), scope("partial")], "partial"],
		["homogeneous failed", [scope("failed"), scope("failed")], "failed"],
		["complete and failed", [scope("complete"), scope("failed")], "partial"],
		["mixed failed and never", [scope("failed"), scope(null)], "partial"],
		["running and failed", [scope("running"), scope("failed")], "running"],
	] as const)("returns %s coverage", (_name, scopes, expected) => {
		expect(aggregateMediaUsageCoverageStatus(scopes)).toBe(expected);
	});
});

describe("media usage summary handler and routes", () => {
	let sqlite: Database.Database;
	let db: Kysely<DatabaseSchema>;
	let queries: string[];
	let usedMedia: MediaItem;
	let unusedMedia: MediaItem;

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
		unusedMedia = await mediaRepository.create({
			filename: "unused.png",
			mimeType: "image/png",
			storageKey: "unused.png",
		});

		await db
			.insertInto("_emdash_collections")
			.values({ id: "collection-posts", slug: "posts", label: "Posts", has_seo: 0 })
			.execute();
		const usageRepository = new MediaUsageRepository(db);
		await usageRepository.upsertIndexStatus({
			adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
			scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
			scopeKey: "posts",
			status: "complete",
			schemaVersion: CONTENT_SOURCE_SCHEMA_VERSION,
		});
		await usageRepository.replaceSource(
			{
				sourceKey: buildContentMediaUsageSourceKey({
					collectionSlug: "posts",
					contentId: "entry-1",
					sourceVariant: "columns",
				}),
				sourceType: "content",
				collectionSlug: "posts",
				contentId: "entry-1",
				sourceVariant: "columns",
				contentStatus: "published",
			},
			[
				{
					fieldSlug: "hero",
					fieldPath: "hero",
					referenceType: "image_field",
					mediaId: usedMedia.id,
					provider: "local",
					providerAssetId: usedMedia.id,
				},
			],
		);
		queries = [];
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await db.destroy();
	});

	it.each([false, true])("skips usage queries for an empty media page", async (includeCount) => {
		const result = await handleMediaUsageSummaries(db, [], { includeCount });

		expect(result).toEqual({ success: true, data: {} });
		expect(queries).toHaveLength(0);
	});

	it("loads coverage once and skips count SQL when counts are redacted", async () => {
		const result = await handleMediaUsageSummaries(db, [usedMedia.id, unusedMedia.id], {
			includeCount: false,
		});

		expect(result).toEqual({
			success: true,
			data: {
				[usedMedia.id]: {
					count: null,
					coverage: { scope: "all_content_collections", status: "complete" },
				},
				[unusedMedia.id]: {
					count: null,
					coverage: { scope: "all_content_collections", status: "complete" },
				},
			},
		});
		expect(queries).toHaveLength(1);
		expect(queries[0]).toContain("_emdash_media_usage_index_status");
	});

	it("loads one coverage query and one batched count query", async () => {
		const result = await handleMediaUsageSummaries(db, [usedMedia.id, unusedMedia.id], {
			includeCount: true,
		});

		expect(result).toEqual(
			expect.objectContaining({
				success: true,
				data: {
					[usedMedia.id]: expect.objectContaining({ count: 1 }),
					[unusedMedia.id]: expect.objectContaining({ count: 0 }),
				},
			}),
		);
		expect(queries).toHaveLength(2);
		expect(queries.filter((query) => query.includes("visible_entries"))).toHaveLength(1);
	});

	it("chunks more than 50 media IDs without becoming N+1", async () => {
		const mediaIds = [
			usedMedia.id,
			...Array.from({ length: 50 }, (_, index) => `unmatched-media-${index}`),
		];

		const result = await handleMediaUsageSummaries(db, mediaIds, { includeCount: true });

		expect(result).toEqual(expect.objectContaining({ success: true }));
		expect(queries).toHaveLength(3);
		expect(queries.filter((query) => query.includes("visible_entries"))).toHaveLength(2);
	});

	it("preserves the list response and query cost without includeUsage", async () => {
		const response = await invokeList("", Role.CONTRIBUTOR);
		const data = await readSuccess<{
			items: MediaListBodyItem[];
			nextCursor?: string;
		}>(response);

		expect(response.status).toBe(200);
		expect(data.items).toHaveLength(2);
		expect(data.items.every((item) => !("usage" in item))).toBe(true);
		expect(data.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: usedMedia.id,
					url: `/_emdash/api/media/file/${usedMedia.storageKey}`,
				}),
			]),
		);
		expect(queries).toHaveLength(1);
	});

	it("attaches numeric usage counts to every list item for an authorized session", async () => {
		const response = await invokeList("?includeUsage=1", Role.CONTRIBUTOR);
		const data = await readSuccess<{ items: MediaListBodyItem[] }>(response);
		const itemsById = new Map(data.items.map((item) => [item.id, item]));

		expect(itemsById.get(usedMedia.id)?.usage).toEqual({
			count: 1,
			coverage: { scope: "all_content_collections", status: "complete" },
		});
		expect(itemsById.get(unusedMedia.id)?.usage?.count).toBe(0);
		expect(queries).toHaveLength(3);
	});

	it.each([
		["subscriber session", Role.SUBSCRIBER, undefined],
		["media token owned by an admin", Role.ADMIN, ["media:read"]],
		["admin token owned by a subscriber", Role.SUBSCRIBER, ["admin"]],
	] as const)("redacts counts and skips count SQL for a %s", async (_name, role, tokenScopes) => {
		const response = await invokeList("?includeUsage=1", role, tokenScopes);
		const data = await readSuccess<{ items: MediaListBodyItem[] }>(response);

		expect(data.items.every((item) => item.usage?.count === null)).toBe(true);
		expect(queries).toHaveLength(2);
		expect(queries.some((query) => query.includes("visible_entries"))).toBe(false);
	});

	it("allows numeric counts for an admin token owned by a contributor", async () => {
		const response = await invokeList("?includeUsage=1", Role.CONTRIBUTOR, ["admin"]);
		const data = await readSuccess<{ items: MediaListBodyItem[] }>(response);

		expect(data.items.find((item) => item.id === usedMedia.id)?.usage?.count).toBe(1);
		expect(queries).toHaveLength(3);
	});

	it("preserves list URLs and cursors when usage is requested", async () => {
		const baselineResponse = await invokeList("?limit=1", Role.CONTRIBUTOR);
		const baseline = await readSuccess<{ items: MediaListBodyItem[]; nextCursor?: string }>(
			baselineResponse,
		);
		queries = [];

		const response = await invokeList("?limit=1&includeUsage=1", Role.CONTRIBUTOR);
		const data = await readSuccess<{ items: MediaListBodyItem[]; nextCursor?: string }>(response);

		expect(data.nextCursor).toBeTypeOf("string");
		expect(data.nextCursor).toBe(baseline.nextCursor);
		expect(data.items[0]?.url).toBe(`/_emdash/api/media/file/${baseline.items[0]?.storageKey}`);
		expect(data.items[0]?.usage).toBeDefined();
		expect(queries).toHaveLength(3);
	});

	it("maps an invalid list includeUsage value to a validation error", async () => {
		const response = await invokeList("?includeUsage=0", Role.CONTRIBUTOR);

		expect(response.status).toBe(400);
		expect((await response.json()) as ErrorBody).toEqual(
			expect.objectContaining({ error: expect.objectContaining({ code: "VALIDATION_ERROR" }) }),
		);
		expect(queries).toHaveLength(0);
	});

	it("adds a summary to media get within the three-query budget", async () => {
		const response = await invokeGet(usedMedia.id, "?includeUsage=1", Role.CONTRIBUTOR);
		const data = await readSuccess<{ item: MediaGetBodyItem }>(response);

		expect(data.item.usage).toEqual({
			count: 1,
			coverage: { scope: "all_content_collections", status: "complete" },
		});
		expect(queries).toHaveLength(3);
	});

	it("preserves media get and its query cost without includeUsage", async () => {
		const response = await invokeGet(usedMedia.id, "", Role.CONTRIBUTOR);
		const data = await readSuccess<{ item: MediaGetBodyItem }>(response);

		expect(response.status).toBe(200);
		expect(data.item).not.toHaveProperty("usage");
		expect(queries).toHaveLength(1);
	});

	it("redacts media get counts without executing count SQL", async () => {
		const response = await invokeGet(usedMedia.id, "?includeUsage=1", Role.SUBSCRIBER);
		const data = await readSuccess<{ item: MediaGetBodyItem }>(response);

		expect(data.item.usage).toEqual({
			count: null,
			coverage: { scope: "all_content_collections", status: "complete" },
		});
		expect(queries).toHaveLength(2);
		expect(queries.some((query) => query.includes("visible_entries"))).toBe(false);
	});

	it("redacts media get counts for a media-read token", async () => {
		const redactedResponse = await invokeGet(usedMedia.id, "?includeUsage=1", Role.ADMIN, [
			"media:read",
		]);
		const redacted = await readSuccess<{ item: MediaGetBodyItem }>(redactedResponse);

		expect(redacted.item.usage?.count).toBeNull();
		expect(queries).toHaveLength(2);
	});

	it("uses the last duplicate includeUsage value and ignores unknown get query keys", async () => {
		const response = await invokeGet(
			usedMedia.id,
			"?includeUsage=0&unknown=value&includeUsage=1",
			Role.CONTRIBUTOR,
		);
		const data = await readSuccess<{ item: MediaGetBodyItem }>(response);

		expect(response.status).toBe(200);
		expect(data.item.usage?.count).toBe(1);
		expect(queries).toHaveLength(3);
	});

	it("validates recognized media get query values", async () => {
		const response = await invokeGet(usedMedia.id, "?includeUsage=false", Role.CONTRIBUTOR);

		expect(response.status).toBe(400);
		expect((await response.json()) as ErrorBody).toEqual(
			expect.objectContaining({ error: expect.objectContaining({ code: "VALIDATION_ERROR" }) }),
		);
		expect(queries).toHaveLength(0);
	});

	it("returns 404 for missing media without running usage queries", async () => {
		const response = await invokeGet("missing", "?includeUsage=1", Role.CONTRIBUTOR);

		expect(response.status).toBe(404);
		expect((await response.json()) as ErrorBody).toEqual(
			expect.objectContaining({ error: expect.objectContaining({ code: "NOT_FOUND" }) }),
		);
		expect(queries).toHaveLength(1);
		expect(queries[0]).not.toContain("_emdash_media_usage");
	});

	it("returns MEDIA_USAGE_READ_ERROR when requested summary loading fails", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await db.schema.dropTable("_emdash_media_usage_index_status").execute();
		queries = [];

		const response = await invokeList("?includeUsage=1", Role.CONTRIBUTOR);

		expect(response.status).toBe(500);
		expect((await response.json()) as ErrorBody).toEqual({
			success: false,
			error: { code: "MEDIA_USAGE_READ_ERROR", message: "Failed to read media usage" },
		});
		expect(errorSpy).toHaveBeenCalledOnce();
	});

	it("returns MEDIA_USAGE_READ_ERROR when requested media get summary loading fails", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await db.schema.dropTable("_emdash_media_usage_index_status").execute();
		queries = [];

		const response = await invokeGet(usedMedia.id, "?includeUsage=1", Role.CONTRIBUTOR);

		expect(response.status).toBe(500);
		expect((await response.json()) as ErrorBody).toEqual({
			success: false,
			error: { code: "MEDIA_USAGE_READ_ERROR", message: "Failed to read media usage" },
		});
		// Kysely's query logger records the successful media lookup but not the failed statement.
		expect(queries).toHaveLength(1);
		expect(errorSpy).toHaveBeenCalledOnce();
	});

	function invokeList(
		query: string,
		role: RoleLevel,
		tokenScopes?: readonly string[],
	): Promise<Response> {
		return listMedia({
			request: new Request(`http://localhost/_emdash/api/media${query}`),
			locals: routeLocals(role, tokenScopes),
		} as ListRouteContext) as Promise<Response>;
	}

	function invokeGet(
		id: string,
		query: string,
		role: RoleLevel,
		tokenScopes?: readonly string[],
	): Promise<Response> {
		return getMediaItem({
			params: { id },
			request: new Request(`http://localhost/_emdash/api/media/${id}${query}`),
			locals: routeLocals(role, tokenScopes),
		} as GetRouteContext) as Promise<Response>;
	}

	function routeLocals(role: RoleLevel, tokenScopes?: readonly string[]) {
		return {
			emdash: {
				db,
				handleMediaList: (params: Parameters<typeof handleMediaList>[1]) =>
					handleMediaList(db, params),
				handleMediaGet: (id: string) => handleMediaGet(db, id),
			},
			user: { id: "user-1", role },
			tokenScopes: tokenScopes ? [...tokenScopes] : undefined,
		};
	}
});

async function readSuccess<T>(response: Response): Promise<T> {
	return ((await response.json()) as SuccessBody<T>).data;
}

function mediaItemFixture(): MediaItem {
	return {
		id: "media-1",
		filename: "hero.png",
		mimeType: "image/png",
		size: null,
		width: null,
		height: null,
		alt: null,
		caption: null,
		storageKey: "hero.png",
		status: "ready",
		contentHash: null,
		blurhash: null,
		dominantColor: null,
		createdAt: "2026-07-13T00:00:00.000Z",
		authorId: null,
	};
}
