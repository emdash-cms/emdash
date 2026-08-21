import { Role, type RoleLevel } from "@emdash-cms/auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { injectCoreRoutes } from "../../../src/astro/integration/routes.js";
import { GET } from "../../../src/astro/routes/api/admin/media-usage/progress.js";
import {
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

type GetContext = Parameters<typeof GET>[0];

describe("admin media usage progress route", () => {
	let ctx: DialectTestContext | undefined;
	let collectionId: string;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections("sqlite");
		const collections = await ctx.db
			.selectFrom("_emdash_collections")
			.select(["id", "slug"])
			.execute();
		collectionId = collections.find(({ slug }) => slug === "post")!.id;
		for (const collection of collections) {
			await ctx.db
				.updateTable("_emdash_media_usage_index_status")
				.set({
					collection_id: collection.id,
					capture_state: "active",
					status: "complete",
					schema_version: 1,
					reconciliation_required: 0,
				})
				.where("adapter_id", "=", "content-media")
				.where("scope_type", "=", "collection")
				.where("scope_key", "=", collection.slug)
				.execute();
		}
		await ctx.db
			.updateTable("_emdash_media_usage_activation")
			.set({ state: "active" })
			.where("task_key", "=", "incremental_capture")
			.execute();
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
		ctx = undefined;
	});

	it("registers the progress route", () => {
		const routes: Array<{ pattern: string; entrypoint: string }> = [];
		injectCoreRoutes((route) => routes.push(route));

		expect(routes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					pattern: "/_emdash/api/admin/media-usage/progress",
					entrypoint: expect.stringContaining("api/admin/media-usage/progress"),
				}),
			]),
		);
	});

	it("requires authentication, schema permission, and admin token scope", async () => {
		await expectError(await GET(routeContext(null)), 401, "UNAUTHORIZED");
		await expectError(await GET(routeContext(Role.EDITOR)), 403, "FORBIDDEN");
		await expectError(
			await GET(routeContext(Role.ADMIN, ["content:read"])),
			403,
			"INSUFFICIENT_SCOPE",
		);
	});

	it("returns aggregate readiness without exposing collection or work details", async () => {
		const response = await GET(routeContext(Role.ADMIN, ["admin"]));

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		const body = await response.json();
		expect(body).toEqual({
			success: true,
			data: {
				status: "ready",
				readyCollections: 2,
				totalCollections: 2,
				indexingStarted: true,
			},
		});
		expect(JSON.stringify(body)).not.toContain(collectionId);
		expect(JSON.stringify(body)).not.toContain("post");
	});

	it("distinguishes indexing startup from a current reconciliation", async () => {
		await ctx!.db
			.updateTable("_emdash_media_usage_index_status")
			.set({
				status: "stale",
				started_at: "2026-01-01T00:00:00.000Z",
				schema_version: 0,
				reconciliation_required: 1,
			})
			.execute();

		const before = await GET(routeContext(Role.ADMIN, ["admin"]));
		expect(await before.json()).toEqual({
			success: true,
			data: {
				status: "indexing",
				readyCollections: 0,
				totalCollections: 2,
				indexingStarted: false,
			},
		});

		await ctx!.db
			.insertInto("_emdash_media_usage_reconciliations")
			.values({
				collection_id: collectionId,
				collection_slug: "post",
				run_token: "current-run",
				next_attempt_at: "2026-08-18T12:00:00.000Z",
				updated_at: "2026-08-18T12:00:00.000Z",
			})
			.execute();

		const after = await GET(routeContext(Role.ADMIN, ["admin"]));
		expect(await after.json()).toEqual({
			success: true,
			data: {
				status: "indexing",
				readyCollections: 0,
				totalCollections: 2,
				indexingStarted: true,
			},
		});
	});

	it("rejects progress reads before activation is active", async () => {
		await ctx!.db
			.updateTable("_emdash_media_usage_activation")
			.set({ state: "activating" })
			.where("task_key", "=", "incremental_capture")
			.execute();

		await expectError(
			await GET(routeContext(Role.ADMIN, ["admin"])),
			409,
			"MEDIA_USAGE_PROGRESS_NOT_ACTIVE",
		);
	});

	it("rejects an incompatible activation runtime generation", async () => {
		await ctx!.db
			.updateTable("_emdash_media_usage_activation")
			.set({ runtime_generation: 2 })
			.where("task_key", "=", "incremental_capture")
			.execute();

		await expectError(
			await GET(routeContext(Role.ADMIN, ["admin"])),
			409,
			"MEDIA_USAGE_ACTIVATION_VERSION_MISMATCH",
		);
	});

	it("returns a stable redacted read error", async () => {
		await ctx!.db.schema.dropTable("_emdash_media_usage_index_status").execute();

		const response = await GET(routeContext(Role.ADMIN, ["admin"]));
		const body = await response.clone().json();

		await expectError(response, 500, "MEDIA_USAGE_PROGRESS_READ_ERROR");
		expect(JSON.stringify(body)).not.toContain("_emdash_media_usage_index_status");
	});

	function routeContext(role: RoleLevel | null, tokenScopes?: string[]): GetContext {
		return {
			request: new Request("http://localhost/_emdash/api/admin/media-usage/progress"),
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
	const body = (await response.json()) as { error: { code: string } };
	expect(body.error.code).toBe(code);
	expect(response.headers.get("Cache-Control")).toBe("private, no-store");
}
