import { Role, type RoleLevel } from "@emdash-cms/auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	handleMediaUsageRepair,
	toMediaUsageRepairResponse,
	type MediaUsageRepairResponse,
} from "../../../src/api/handlers/media-usage.js";
import { injectCoreRoutes } from "../../../src/astro/integration/routes.js";
import { POST } from "../../../src/astro/routes/api/admin/media-usage/repair.js";
import {
	CONTENT_MEDIA_USAGE_ADAPTER_ID,
	CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
} from "../../../src/media/usage/content-refresh.js";
import type {
	ContentMediaUsageRepairAllResult,
	ContentMediaUsageRepairCollectionResult,
	ContentMediaUsageRepairStatus,
} from "../../../src/media/usage/content-repair.js";
import {
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

type RouteContext = Parameters<typeof POST>[0];

interface ApiErrorBody {
	error: {
		code: string;
		message: string;
	};
}

interface ApiSuccessBody<T> {
	data: T;
}

describe("admin media usage repair route", () => {
	let ctx: DialectTestContext | undefined;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections("sqlite");
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
		ctx = undefined;
	});

	it("registers the repair route under the admin API prefix", () => {
		const routes: Array<{ pattern: string; entrypoint: string }> = [];
		injectCoreRoutes((route) => routes.push(route));
		const repairRouteRegistration = routes.find(
			(route) => route.pattern === "/_emdash/api/admin/media-usage/repair",
		);

		expect(repairRouteRegistration).toEqual(
			expect.objectContaining({
				pattern: "/_emdash/api/admin/media-usage/repair",
				entrypoint: expect.stringContaining("api/admin/media-usage/repair"),
			}),
		);
		expect(repairRouteRegistration?.pattern.startsWith("/_emdash/api/admin/")).toBe(true);
	});

	it("returns 401 without an authenticated user", async () => {
		const response = await invokeRepairRoute({ scope: "collection", collection: "post" }, null);

		await expectError(response, 401, "UNAUTHORIZED");
	});

	it("returns 403 when a non-admin user lacks schema:manage", async () => {
		const response = await invokeRepairRoute(
			{ scope: "collection", collection: "post" },
			Role.EDITOR,
		);

		await expectError(response, 403, "FORBIDDEN");
	});

	it("returns 500 when EmDash is not initialized", async () => {
		const request = jsonRequest({ scope: "collection", collection: "post" });
		const response = await POST({
			request,
			locals: {
				emdash: {},
				user: { id: "admin-1", role: Role.ADMIN },
			},
		} as RouteContext);

		await expectError(response, 500, "NOT_CONFIGURED");
	});

	it("returns 500 when EmDash is not initialized before checking user auth", async () => {
		const request = jsonRequest({ scope: "collection", collection: "post" });
		const response = await POST({
			request,
			locals: {
				emdash: {},
				user: null,
			},
		} as RouteContext);

		await expectError(response, 500, "NOT_CONFIGURED");
	});

	it("returns 400 for invalid JSON", async () => {
		const request = new Request("http://localhost/_emdash/api/admin/media-usage/repair", {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
			body: "{",
		});

		const response = await POST(routeContext(request, Role.ADMIN));

		await expectError(response, 400, "INVALID_JSON");
	});

	it("returns 400 for a body-less POST instead of defaulting to all-content repair", async () => {
		const request = new Request("http://localhost/_emdash/api/admin/media-usage/repair", {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
		});

		const response = await POST(routeContext(request, Role.ADMIN));

		await expectError(response, 400, "INVALID_JSON");
	});

	it.each([
		["invalid collection slug", { scope: "collection", collection: "1bad" }],
		["whitespace-padded collection slug", { scope: "collection", collection: " post " }],
		["unknown request key", { scope: "collection", collection: "post", extra: true }],
		["missing scope", { collection: "post" }],
		["extra key on all-content repair", { scope: "all", collection: "post" }],
	])("returns 400 validation errors for %s", async (_name, body) => {
		const response = await invokeRepairRoute(body, Role.ADMIN);

		await expectError(response, 400, "VALIDATION_ERROR");
	});

	it("repairs one collection and returns the mapped single-collection response", async () => {
		const response = await invokeRepairRoute(
			{ scope: "collection", collection: "post" },
			Role.ADMIN,
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as ApiSuccessBody<MediaUsageRepairResponse>;
		expect(body.data).toEqual({
			status: "complete",
			indexedSourceCount: 0,
			failedSourceCount: 0,
			skippedSourceCount: 0,
			deletedSourceCount: 0,
			collections: [
				expect.objectContaining({
					collection: "post",
					status: "complete",
					indexedSourceCount: 0,
					failedSourceCount: 0,
					skippedSourceCount: 0,
					deletedSourceCount: 0,
					lastErrorCode: null,
					startedAt: expect.any(String),
					completedAt: expect.any(String),
				}),
			],
		});
	});

	it("repairs all content collections and preserves service collection order", async () => {
		const response = await invokeRepairRoute({ scope: "all" }, Role.ADMIN);

		expect(response.status).toBe(200);
		const data = await readSuccessData(response);
		expect(data.status).toBe("complete");
		expect(data.indexedSourceCount).toBe(0);
		expect(data.collections.map((collection) => collection.collection)).toEqual(["page", "post"]);
	});

	it("returns structured failed repair results for unknown collections", async () => {
		const response = await invokeRepairRoute(
			{ scope: "collection", collection: "missing" },
			Role.ADMIN,
		);

		expect(response.status).toBe(200);
		const data = await readSuccessData(response);
		expect(data).toEqual({
			status: "failed",
			indexedSourceCount: 0,
			failedSourceCount: 0,
			skippedSourceCount: 0,
			deletedSourceCount: 0,
			collections: [
				expect.objectContaining({
					collection: "missing",
					status: "failed",
					lastErrorCode: "COLLECTION_NOT_FOUND",
				}),
			],
		});
	});

	it("lets the handler invoke collection repair directly", async () => {
		const result = await handleMediaUsageRepair(ctx!.db, {
			scope: "collection",
			collection: "post",
		});

		expect(result).toEqual(
			expect.objectContaining({
				success: true,
				data: expect.objectContaining({
					status: "complete",
					collections: [expect.objectContaining({ collection: "post" })],
				}),
			}),
		);
	});

	it("lets the handler invoke all-content repair directly", async () => {
		const result = await handleMediaUsageRepair(ctx!.db, { scope: "all" });

		expect(result).toEqual(
			expect.objectContaining({
				success: true,
				data: expect.objectContaining({
					status: "complete",
					collections: [
						expect.objectContaining({ collection: "page" }),
						expect.objectContaining({ collection: "post" }),
					],
				}),
			}),
		);
	});

	it("rejects malformed internal handler scopes without broadening to all-content repair", async () => {
		const beforeRows = await mediaUsageStatusRows();
		const result = await handleMediaUsageRepair(ctx!.db, {
			scope: "collecton",
			collection: "post",
		} as never);

		expect(result).toEqual({
			success: false,
			error: {
				code: "VALIDATION_ERROR",
				message: "Invalid media usage repair request",
			},
		});
		expect(await mediaUsageStatusRows()).toEqual(beforeRows);
	});

	function mediaUsageStatusRows(): Promise<Array<{ scope_key: string }>> {
		return ctx!.db
			.selectFrom("_emdash_media_usage_index_status")
			.select("scope_key")
			.orderBy("scope_key", "asc")
			.execute();
	}

	async function invokeRepairRoute(body: unknown, role: RoleLevel | null): Promise<Response> {
		return POST(routeContext(jsonRequest(body), role));
	}

	function routeContext(request: Request, role: RoleLevel | null): RouteContext {
		return {
			request,
			locals: {
				emdash: { db: ctx!.db },
				user: role == null ? null : { id: "user-1", role },
			},
		} as RouteContext;
	}
});

describe("media usage repair response mapping", () => {
	it.each<ContentMediaUsageRepairStatus>(["complete", "partial", "failed", "stale"])(
		"maps %s collection status as a 200-domain result",
		(status) => {
			const response = toMediaUsageRepairResponse(collectionResult("posts", status));

			expect(response.status).toBe(status);
			expect(response.collections).toEqual([
				expect.objectContaining({
					collection: "posts",
					status,
					lastErrorCode: status === "complete" ? null : "CONTENT_USAGE_REPAIR_CONFLICT",
					completedAt: status === "stale" ? null : "2026-07-07T00:00:01.000Z",
				}),
			]);
			expect(response.collections[0]).not.toHaveProperty("scope");
		},
	);

	it("maps all-content aggregate counts and collection order", () => {
		const allResult: ContentMediaUsageRepairAllResult = {
			status: "partial",
			indexedSourceCount: 3,
			failedSourceCount: 1,
			skippedSourceCount: 2,
			deletedSourceCount: 4,
			collections: [collectionResult("articles", "complete"), collectionResult("zines", "failed")],
		};

		expect(toMediaUsageRepairResponse(allResult)).toEqual({
			status: "partial",
			indexedSourceCount: 3,
			failedSourceCount: 1,
			skippedSourceCount: 2,
			deletedSourceCount: 4,
			collections: [
				expect.objectContaining({ collection: "articles", status: "complete" }),
				expect.objectContaining({ collection: "zines", status: "failed" }),
			],
		});
	});
});

async function expectError(response: Response, status: number, code: string): Promise<void> {
	expect(response.status).toBe(status);
	const body = (await response.json()) as ApiErrorBody;
	expect(body.error.code).toBe(code);
}

async function readSuccessData(
	response: Response,
): Promise<ReturnType<typeof toMediaUsageRepairResponse>> {
	const body = (await response.json()) as ApiSuccessBody<
		ReturnType<typeof toMediaUsageRepairResponse>
	>;
	return body.data;
}

function jsonRequest(body: unknown): Request {
	return new Request("http://localhost/_emdash/api/admin/media-usage/repair", {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
		body: JSON.stringify(body),
	});
}

function collectionResult(
	collection: string,
	status: ContentMediaUsageRepairStatus,
): ContentMediaUsageRepairCollectionResult {
	return {
		scope: {
			adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
			scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
			scopeKey: collection,
		},
		status,
		indexedSourceCount: status === "complete" ? 1 : 0,
		failedSourceCount: status === "failed" ? 1 : 0,
		skippedSourceCount: status === "partial" || status === "stale" ? 1 : 0,
		deletedSourceCount: 0,
		lastErrorCode: status === "complete" ? null : "CONTENT_USAGE_REPAIR_CONFLICT",
		startedAt: "2026-07-07T00:00:00.000Z",
		completedAt: status === "stale" ? null : "2026-07-07T00:00:01.000Z",
	};
}
