import { Role, type RoleLevel } from "@emdash-cms/auth";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { injectCoreRoutes } from "../../../src/astro/integration/routes.js";
import { GET, POST } from "../../../src/astro/routes/api/admin/media-usage/activation.js";
import {
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

type GetContext = Parameters<typeof GET>[0];

describe("admin media usage activation status route", () => {
	let ctx: DialectTestContext | undefined;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections("sqlite");
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
		ctx = undefined;
	});

	it("registers the activation route", () => {
		const routes: Array<{ pattern: string; entrypoint: string }> = [];
		injectCoreRoutes((route) => routes.push(route));

		expect(routes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					pattern: "/_emdash/api/admin/media-usage/activation",
					entrypoint: expect.stringContaining("api/admin/media-usage/activation"),
				}),
			]),
		);
	});

	it("requires authentication, schema permission, and admin token scope", async () => {
		const request = activationRequest();

		await expectError(await GET(routeContext(request, null)), 401, "UNAUTHORIZED");
		await expectError(await GET(routeContext(request, Role.EDITOR)), 403, "FORBIDDEN");
		await expectError(
			await GET(routeContext(request, Role.ADMIN, ["content:read"])),
			403,
			"INSUFFICIENT_SCOPE",
		);

		const post = () => activationPost({ writersDrained: true });
		await expectError(await POST(routeContext(post(), null)), 401, "UNAUTHORIZED");
		await expectError(await POST(routeContext(post(), Role.EDITOR)), 403, "FORBIDDEN");
		await expectError(
			await POST(routeContext(post(), Role.ADMIN, ["content:read"])),
			403,
			"INSUFFICIENT_SCOPE",
		);
	});

	it("returns a read-only redacted activation status", async () => {
		await ctx!.db
			.updateTable("_emdash_media_usage_activation")
			.set({
				state: "activating",
				collection_cursor: "posts",
				drain_confirmed_at: "2026-08-12T09:00:00.000Z",
				lease_token: "private-lease-token",
				lease_expires_at: "2026-08-12T09:05:00.000Z",
				attempt_count: 3,
				last_attempted_at: "2026-08-12T09:00:00.000Z",
				last_error_code: "private-database-error",
				activated_at: null,
				updated_at: "2026-08-12T09:00:01.000Z",
			})
			.where("task_key", "=", "incremental_capture")
			.execute();
		const before = await activationRow();

		const response = await GET(routeContext(activationRequest(), Role.ADMIN, ["admin"]));

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		const body = await response.json();
		expect(body).toEqual({
			success: true,
			data: {
				state: "activating",
				collectionCursor: "posts",
				attemptCount: 3,
				drainConfirmedAt: "2026-08-12T09:00:00.000Z",
				lastAttemptedAt: "2026-08-12T09:00:00.000Z",
				lastErrorCode: "MEDIA_USAGE_ACTIVATION_FAILED",
				leaseExpiresAt: "2026-08-12T09:05:00.000Z",
				activatedAt: null,
				updatedAt: "2026-08-12T09:00:01.000Z",
			},
		});
		expect(await activationRow()).toEqual(before);
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain("private-lease-token");
		expect(serialized).not.toContain("private-database-error");
		expect(serialized).not.toContain("runtime_generation");
	});

	it("fails closed for an incompatible runtime generation", async () => {
		await ctx!.db
			.updateTable("_emdash_media_usage_activation")
			.set({ runtime_generation: 2 })
			.where("task_key", "=", "incremental_capture")
			.execute();

		const before = await activationRow();
		await expectError(
			await GET(routeContext(activationRequest(), Role.ADMIN)),
			409,
			"MEDIA_USAGE_ACTIVATION_VERSION_MISMATCH",
		);
		await expectError(
			await POST(routeContext(activationPost({ writersDrained: true }), Role.ADMIN)),
			409,
			"MEDIA_USAGE_ACTIVATION_VERSION_MISMATCH",
		);
		expect(await activationRow()).toEqual(before);
	});

	it("fails closed for missing or invalid lifecycle metadata", async () => {
		await ctx!.db
			.updateTable("_emdash_media_usage_activation")
			.set({ state: "unexpected" })
			.where("task_key", "=", "incremental_capture")
			.execute();
		await expectError(
			await GET(routeContext(activationRequest(), Role.ADMIN)),
			500,
			"MEDIA_USAGE_ACTIVATION_READ_ERROR",
		);
		await ctx!.db
			.updateTable("_emdash_media_usage_activation")
			.set({ state: "expanded", attempt_count: -1 })
			.where("task_key", "=", "incremental_capture")
			.execute();
		await expectError(
			await GET(routeContext(activationRequest(), Role.ADMIN)),
			500,
			"MEDIA_USAGE_ACTIVATION_READ_ERROR",
		);

		await ctx!.db.deleteFrom("_emdash_media_usage_activation").execute();
		await expectError(
			await GET(routeContext(activationRequest(), Role.ADMIN)),
			500,
			"MEDIA_USAGE_ACTIVATION_READ_ERROR",
		);
	});

	it("requires both literal confirmations without mutating activation state", async () => {
		const before = await activationRow();
		for (const body of [{}, { writersDrained: false }, { writersDrained: true, extra: true }]) {
			await expectError(
				await POST(routeContext(activationPost(body), Role.ADMIN)),
				400,
				"VALIDATION_ERROR",
			);
			expect(await activationRow()).toEqual(before);
		}
	});

	it("advances exactly one collection per confirmed request and is idempotent when active", async () => {
		const first = await POST(
			routeContext(activationPost({ writersDrained: true }), Role.ADMIN, ["admin"]),
		);
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({
			success: true,
			data: {
				outcome: "activating",
				processedCollections: 1,
				activation: expect.objectContaining({ state: "activating" }),
			},
		});
		const second = await POST(routeContext(activationPost({ writersDrained: true }), Role.ADMIN));
		expect(second.status).toBe(200);
		expect(await second.json()).toEqual({
			success: true,
			data: {
				outcome: "active",
				processedCollections: 1,
				activation: expect.objectContaining({ state: "active" }),
			},
		});

		const third = await POST(routeContext(activationPost({ writersDrained: true }), Role.ADMIN));
		expect(await third.json()).toEqual({
			success: true,
			data: {
				outcome: "active",
				processedCollections: 0,
				activation: expect.objectContaining({ state: "active" }),
			},
		});
	});

	it("returns a stable redacted conflict for a live activation lease", async () => {
		await ctx!.db
			.updateTable("_emdash_media_usage_activation")
			.set({
				state: "activating",
				lease_token: "private-owner-token",
				lease_expires_at: "2100-01-01T00:00:00.000Z",
			})
			.where("task_key", "=", "incremental_capture")
			.execute();

		const response = await POST(routeContext(activationPost({ writersDrained: true }), Role.ADMIN));
		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body).toEqual({
			success: false,
			error: {
				code: "MEDIA_USAGE_ACTIVATION_BUSY",
				message: expect.any(String),
				details: { leaseExpiresAt: "2100-01-01T00:00:00.000Z" },
			},
		});
		expect(JSON.stringify(body)).not.toContain("private-owner-token");
	});

	it("maps ownership loss to a stable conflict", async () => {
		await sql`
			CREATE TRIGGER steal_activation_lease_from_route
			AFTER UPDATE OF capture_state ON _emdash_media_usage_index_status
			WHEN NEW.capture_state = 'active'
			BEGIN
				UPDATE _emdash_media_usage_activation
				SET lease_token = 'new-owner',
					lease_expires_at = '2100-01-01T00:00:00.000Z'
				WHERE task_key = 'incremental_capture';
			END
		`.execute(ctx!.db);

		await expectError(
			await POST(routeContext(activationPost({ writersDrained: true }), Role.ADMIN)),
			409,
			"MEDIA_USAGE_ACTIVATION_CONFLICT",
		);
	});

	it("records trigger failures while returning only a stable public error", async () => {
		await sql`DROP TABLE ${sql.ref("ec_page")}`.execute(ctx!.db);

		const response = await POST(routeContext(activationPost({ writersDrained: true }), Role.ADMIN));
		expect(response.status).toBe(500);
		const body = await response.json();
		expect(body).toEqual({
			success: false,
			error: {
				code: "MEDIA_USAGE_ACTIVATION_ADVANCE_ERROR",
				message: expect.any(String),
			},
		});
		expect(JSON.stringify(body)).not.toContain("ec_page");
		expect(await activationRow()).toEqual(
			expect.objectContaining({
				state: "activating",
				lease_token: null,
				last_error_code: "MEDIA_USAGE_ACTIVATION_FAILED",
			}),
		);
	});

	function activationRow() {
		return ctx!.db
			.selectFrom("_emdash_media_usage_activation")
			.selectAll()
			.where("task_key", "=", "incremental_capture")
			.executeTakeFirst();
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
	const body = (await response.json()) as { error: { code: string } };
	expect(body.error.code).toBe(code);
	expect(response.headers.get("Cache-Control")).toBe("private, no-store");
}

function activationRequest(): Request {
	return new Request("http://localhost/_emdash/api/admin/media-usage/activation");
}

function activationPost(body: unknown): Request {
	return new Request("http://localhost/_emdash/api/admin/media-usage/activation", {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
		body: JSON.stringify(body),
	});
}
