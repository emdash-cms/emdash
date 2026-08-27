import { Role, type RoleLevel } from "@emdash-cms/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { injectCoreRoutes } from "../../../src/astro/integration/routes.js";
import { GET, POST } from "../../../src/astro/routes/api/admin/media-usage/progress.js";
import * as maintenanceEngine from "../../../src/media/usage/maintenance-engine.js";
import {
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

type RouteContext = Parameters<typeof GET>[0];

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
		vi.restoreAllMocks();
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

	it("requires authentication, schema permission, and admin token scope to advance", async () => {
		await expectError(await POST(routeContext(null, undefined, "POST")), 401, "UNAUTHORIZED");
		await expectError(await POST(routeContext(Role.EDITOR, undefined, "POST")), 403, "FORBIDDEN");
		await expectError(
			await POST(routeContext(Role.ADMIN, ["content:read"], "POST")),
			403,
			"INSUFFICIENT_SCOPE",
		);
	});

	it("runs one maintenance step and returns the stored state after it", async () => {
		const response = await POST(routeContext(Role.ADMIN, ["admin"], "POST"));

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		const body = await response.json();
		expect(body).toEqual({
			success: true,
			data: {
				activation: expect.objectContaining({ state: "active" }),
				progress: {
					status: "ready",
					readyCollections: 2,
					totalCollections: 2,
				},
				nextRequestInMs: null,
			},
		});
		expect(JSON.stringify(body)).not.toContain(collectionId);
		expect(JSON.stringify(body)).not.toContain("post");
	});

	it("returns immediate continuation after exactly one activation step", async () => {
		await ctx!.db
			.updateTable("_emdash_media_usage_activation")
			.set({
				state: "activating",
				drain_confirmed_at: "2026-08-24T00:00:00.000Z",
				activated_at: null,
				lease_token: null,
				lease_expires_at: null,
			})
			.where("task_key", "=", "incremental_capture")
			.execute();

		const response = await POST(routeContext(Role.ADMIN, ["admin"], "POST"));
		const body = await response.json();

		expect(body).toEqual({
			success: true,
			data: {
				activation: expect.objectContaining({ state: "activating", collectionCursor: "page" }),
				progress: null,
				nextRequestInMs: 0,
			},
		});
	});

	it("returns delayed continuation while another activation lease is live", async () => {
		await ctx!.db
			.updateTable("_emdash_media_usage_activation")
			.set({
				state: "activating",
				drain_confirmed_at: "2026-08-24T00:00:00.000Z",
				activated_at: null,
				lease_token: "other-owner",
				lease_expires_at: "2999-01-01T00:00:00.000Z",
			})
			.where("task_key", "=", "incremental_capture")
			.execute();

		const response = await POST(routeContext(Role.ADMIN, ["admin"], "POST"));
		const body = await response.json();

		expect(body).toEqual({
			success: true,
			data: {
				activation: expect.objectContaining({ state: "activating" }),
				progress: null,
				nextRequestInMs: 30_000,
			},
		});
	});

	it("continues when durable progress becomes incomplete after an idle step", async () => {
		vi.spyOn(maintenanceEngine, "runMediaUsageMaintenanceStep").mockResolvedValue({
			state: "idle",
			continuation: { kind: "none" },
		});
		await ctx!.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ status: "stale", schema_version: 0, reconciliation_required: 1 })
			.where("collection_id", "=", collectionId)
			.execute();

		const response = await POST(routeContext(Role.ADMIN, ["admin"], "POST"));
		const body = await response.json();

		expect(body).toEqual({
			success: true,
			data: {
				activation: expect.objectContaining({ state: "active" }),
				progress: expect.objectContaining({ status: "indexing" }),
				nextRequestInMs: 0,
			},
		});
	});

	it("stops when stored progress needs attention", async () => {
		vi.spyOn(maintenanceEngine, "runMediaUsageMaintenanceStep").mockResolvedValue({
			state: "progress",
			continuation: { kind: "immediate" },
		});
		await ctx!.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ status: "failed", last_error_code: "MEDIA_USAGE_PROCESSING_FAILED" })
			.where("collection_id", "=", collectionId)
			.execute();

		const response = await POST(routeContext(Role.ADMIN, ["admin"], "POST"));
		const body = await response.json();

		expect(body).toEqual({
			success: true,
			data: {
				activation: expect.objectContaining({ state: "active" }),
				progress: expect.objectContaining({ status: "needs_attention" }),
				nextRequestInMs: null,
			},
		});
	});

	it("rejects untouched activation without changing it", async () => {
		await ctx!.db
			.updateTable("_emdash_media_usage_activation")
			.set({ state: "expanded" })
			.where("task_key", "=", "incremental_capture")
			.execute();

		await expectError(
			await POST(routeContext(Role.ADMIN, ["admin"], "POST")),
			409,
			"MEDIA_USAGE_PROGRESS_NOT_ACTIVE",
		);
		expect(
			await ctx!.db
				.selectFrom("_emdash_media_usage_activation")
				.select("state")
				.where("task_key", "=", "incremental_capture")
				.executeTakeFirstOrThrow(),
		).toEqual({ state: "expanded" });
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
			},
		});
		expect(JSON.stringify(body)).not.toContain(collectionId);
		expect(JSON.stringify(body)).not.toContain("post");
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
		await expectError(
			await POST(routeContext(Role.ADMIN, ["admin"], "POST")),
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

	it("returns a stable redacted advance error", async () => {
		await ctx!.db.schema.dropTable("_emdash_media_usage_activation").execute();

		const response = await POST(routeContext(Role.ADMIN, ["admin"], "POST"));
		const body = await response.clone().json();

		await expectError(response, 500, "MEDIA_USAGE_PROGRESS_ADVANCE_ERROR");
		expect(JSON.stringify(body)).not.toContain("_emdash_media_usage_activation");
	});

	function routeContext(
		role: RoleLevel | null,
		tokenScopes?: string[],
		method: "GET" | "POST" = "GET",
	): RouteContext {
		return {
			request: new Request("http://localhost/_emdash/api/admin/media-usage/progress", { method }),
			locals: {
				emdash: { db: ctx!.db },
				user: role == null ? null : { id: "user-1", role },
				tokenScopes,
			},
		} as RouteContext;
	}
});

async function expectError(response: Response, status: number, code: string): Promise<void> {
	expect(response.status).toBe(status);
	const body = (await response.json()) as { error: { code: string } };
	expect(body.error.code).toBe(code);
	expect(response.headers.get("Cache-Control")).toBe("private, no-store");
}
