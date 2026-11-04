import { Role, type RoleLevel } from "@emdash-cms/auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { injectCoreRoutes } from "../../../src/astro/integration/routes.js";
import { GET } from "../../../src/astro/routes/api/admin/media-usage/work/index.js";
import { POST } from "../../../src/astro/routes/api/admin/media-usage/work/retry.js";
import {
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

type GetContext = Parameters<typeof GET>[0];

interface ApiErrorBody {
	error: {
		code: string;
		message: string;
		details?: Record<string, unknown>;
	};
}

describe("admin media usage work routes", () => {
	let ctx: DialectTestContext | undefined;
	let collectionId: string;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections("sqlite");
		const collection = await ctx.db
			.selectFrom("_emdash_collections")
			.select(["id", "slug"])
			.where("slug", "=", "post")
			.executeTakeFirstOrThrow();
		collectionId = collection.id;
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({
				collection_id: collectionId,
				capture_state: "active",
				status: "complete",
				completed_at: "2026-08-01T00:00:00.000Z",
				reconciliation_required: 0,
			})
			.where("adapter_id", "=", "content-media")
			.where("scope_type", "=", "collection")
			.where("scope_key", "=", "post")
			.execute();
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
		ctx = undefined;
	});

	it("registers the list and retry routes under the admin API prefix", () => {
		const routes: Array<{ pattern: string; entrypoint: string }> = [];
		injectCoreRoutes((route) => routes.push(route));

		expect(routes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					pattern: "/_emdash/api/admin/media-usage/work",
					entrypoint: expect.stringContaining("api/admin/media-usage/work/index"),
				}),
				expect.objectContaining({
					pattern: "/_emdash/api/admin/media-usage/work/retry",
					entrypoint: expect.stringContaining("api/admin/media-usage/work/retry"),
				}),
			]),
		);
	});

	it("requires authentication, schema permission, and admin token scope", async () => {
		const request = listRequest("collection=post");

		await expectError(await GET(routeContext(request, null)), 401, "UNAUTHORIZED");
		await expectError(await GET(routeContext(request, Role.EDITOR)), 403, "FORBIDDEN");
		await expectError(
			await GET(routeContext(request, Role.ADMIN, ["content:read"])),
			403,
			"INSUFFICIENT_SCOPE",
		);
	});

	it("returns a bounded redacted page with private no-store caching", async () => {
		await insertWork({
			contentId: "entry-failed",
			state: "failed",
			workVersion: 9,
			leaseToken: "private-lease-token",
			lastErrorCode: "MEDIA_USAGE_PROCESSING_FAILED",
		});

		const response = await GET(
			routeContext(listRequest("collection=post&state=failed&limit=1"), Role.ADMIN, ["admin"]),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		const body = (await response.json()) as {
			data: { items: Array<Record<string, unknown>>; nextCursor?: string };
		};
		expect(body.data.items).toEqual([
			expect.objectContaining({
				collectionId,
				collectionSlug: "post",
				contentId: "entry-failed",
				state: "failed",
				attemptCount: 0,
				lastErrorCode: "MEDIA_USAGE_PROCESSING_FAILED",
			}),
		]);
		expect(body.data.items[0]).not.toHaveProperty("leaseToken");
		expect(body.data.items[0]).not.toHaveProperty("workVersion");
		expect(body.data.items[0]).not.toHaveProperty("changeEpoch");
		expect(JSON.stringify(body)).not.toContain("private-lease-token");
	});

	it("returns structured query and cursor errors", async () => {
		await expectError(
			await GET(routeContext(listRequest("collection=1bad"), Role.ADMIN)),
			400,
			"VALIDATION_ERROR",
		);
		await expectError(
			await GET(routeContext(listRequest("collection=post&limit=101"), Role.ADMIN)),
			400,
			"VALIDATION_ERROR",
		);
		await expectError(
			await GET(routeContext(listRequest("collection=post&cursor=not-a-cursor"), Role.ADMIN)),
			400,
			"INVALID_CURSOR",
		);
	});

	it("returns collection not found without exposing a database error", async () => {
		await expectError(
			await GET(routeContext(listRequest("collection=missing"), Role.ADMIN)),
			404,
			"COLLECTION_NOT_FOUND",
		);
	});

	it("requires permission and admin scope on retry independently of middleware", async () => {
		const request = retryRequest({ collectionId, contentId: "entry-failed" });

		await expectError(await POST(routeContext(request, null)), 401, "UNAUTHORIZED");
		await expectError(await POST(routeContext(request, Role.EDITOR)), 403, "FORBIDDEN");
		await expectError(
			await POST(routeContext(request, Role.ADMIN, ["media:write"])),
			403,
			"INSUFFICIENT_SCOPE",
		);
	});

	it("reopens one failed job without returning internal ownership fields", async () => {
		await insertWork({
			contentId: "entry-failed",
			state: "failed",
			workVersion: 5,
			leaseToken: "old-private-token",
			lastErrorCode: "MEDIA_USAGE_PROCESSING_FAILED",
		});

		const response = await POST(
			routeContext(retryRequest({ collectionId, contentId: "entry-failed" }), Role.ADMIN, [
				"admin",
			]),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			data: { changed: boolean; item: Record<string, unknown> };
		};
		expect(body.data).toEqual({
			changed: true,
			item: expect.objectContaining({
				collectionId,
				contentId: "entry-failed",
				state: "pending",
				attemptCount: 0,
				leaseExpiresAt: null,
				lastErrorCode: null,
			}),
		});
		expect(JSON.stringify(body)).not.toContain("old-private-token");
		expect(body.data.item).not.toHaveProperty("workVersion");
	});

	it("returns a stable redacted conflict for a live lease", async () => {
		await insertWork({
			contentId: "entry-live",
			state: "leased",
			workVersion: 3,
			leaseToken: "live-private-token",
			leaseExpiresAt: "2100-01-01T00:00:00.000Z",
		});

		const response = await POST(
			routeContext(retryRequest({ collectionId, contentId: "entry-live" }), Role.ADMIN),
		);

		expect(response.status).toBe(409);
		const body = (await response.json()) as ApiErrorBody;
		expect(body.error).toEqual({
			code: "WORK_LEASE_ACTIVE",
			message: expect.any(String),
			details: { leaseExpiresAt: "2100-01-01T00:00:00.000Z" },
		});
		expect(JSON.stringify(body)).not.toContain("live-private-token");
	});

	it("rejects malformed and unknown retry identities", async () => {
		await expectError(
			await POST(routeContext(retryRequest({ collectionId: "", contentId: "entry" }), Role.ADMIN)),
			400,
			"VALIDATION_ERROR",
		);
		await expectError(
			await POST(
				routeContext(
					retryRequest({ collectionId, contentId: "entry", unexpected: true }),
					Role.ADMIN,
				),
			),
			400,
			"VALIDATION_ERROR",
		);
		await expectError(
			await POST(
				routeContext(
					retryRequest({ collectionId: "missing-collection", contentId: "entry" }),
					Role.ADMIN,
				),
			),
			404,
			"COLLECTION_NOT_FOUND",
		);
	});

	async function insertWork(input: {
		contentId: string;
		state: "pending" | "retry" | "leased" | "failed";
		workVersion: number;
		leaseToken?: string | null;
		leaseExpiresAt?: string | null;
		lastErrorCode?: string | null;
	}): Promise<void> {
		await ctx!.db
			.insertInto("_emdash_media_usage_work")
			.values({
				collection_id: collectionId,
				collection_slug: "post",
				content_id: input.contentId,
				change_epoch: 0,
				work_version: input.workVersion,
				state: input.state,
				attempt_count: 0,
				next_attempt_at: "2000-01-01T00:00:00.000Z",
				lease_token: input.leaseToken ?? null,
				lease_expires_at: input.leaseExpiresAt ?? null,
				last_attempted_at: null,
				last_error_code: input.lastErrorCode ?? null,
				created_at: "2026-08-06T12:00:00.000Z",
				updated_at: "2026-08-06T12:00:00.000Z",
			})
			.execute();
	}

	function routeContext(
		request: Request,
		role: RoleLevel | null,
		tokenScopes?: string[],
	): GetContext {
		return {
			request,
			locals: {
				emdash: { db: ctx!.db },
				user: role == null ? null : { id: "user-1", role },
				tokenScopes,
			},
		} as GetContext;
	}
});

async function expectError(response: Response, status: number, code: string): Promise<void> {
	expect(response.status).toBe(status);
	const body = (await response.json()) as ApiErrorBody;
	expect(body.error.code).toBe(code);
	expect(response.headers.get("Cache-Control")).toBe("private, no-store");
}

function listRequest(query: string): Request {
	return new Request(`http://localhost/_emdash/api/admin/media-usage/work?${query}`);
}

function retryRequest(body: unknown): Request {
	return new Request("http://localhost/_emdash/api/admin/media-usage/work/retry", {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
		body: JSON.stringify(body),
	});
}
