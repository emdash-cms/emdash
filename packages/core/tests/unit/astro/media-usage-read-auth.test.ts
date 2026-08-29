import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

vi.mock(
	"virtual:emdash/auth",
	() => ({
		authenticate: vi.fn(),
	}),
	{ virtual: true },
);

vi.mock(
	"virtual:emdash/config",
	() => ({
		default: {},
	}),
	{ virtual: true },
);

import { handleApiTokenCreate } from "../../../src/api/handlers/api-tokens.js";
import { onRequest as authMiddleware } from "../../../src/astro/middleware/auth.js";
import { GET } from "../../../src/astro/routes/api/media/[id]/usage.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

type AuthContext = Parameters<typeof authMiddleware>[0];

interface ApiErrorBody {
	error: {
		code: string;
		message: string;
	};
}

describe("media usage detail auth middleware", () => {
	let db: Kysely<Database> | undefined;
	let mediaId: string;

	beforeEach(async () => {
		db = await setupTestDatabase();
		await db
			.insertInto("users")
			.values([
				{
					id: "contributor-1",
					email: "contributor@example.com",
					name: "Contributor",
					role: Role.CONTRIBUTOR,
					email_verified: 1,
				},
				{
					id: "subscriber-1",
					email: "subscriber@example.com",
					name: "Subscriber",
					role: Role.SUBSCRIBER,
					email_verified: 1,
				},
			])
			.execute();
		mediaId = (
			await new MediaRepository(db).create({
				filename: "usage.png",
				mimeType: "image/png",
				storageKey: "usage.png",
			})
		).id;
	});

	afterEach(async () => {
		if (db) await teardownTestDatabase(db);
		db = undefined;
	});

	it("allows an admin-scoped token for a contributor to read usage details", async () => {
		const response = await invokeThroughAuth(await createToken("contributor-1", ["admin"]));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const stored = await db!
			.selectFrom("_emdash_api_tokens")
			.select("last_used_at")
			.where("user_id", "=", "contributor-1")
			.executeTakeFirstOrThrow();

		expect(response.status).toBe(200);
		expect((await response.json()) as { data: { items: unknown[] } }).toEqual(
			expect.objectContaining({ data: expect.objectContaining({ items: [] }) }),
		);
		expect(stored.last_used_at).not.toBeNull();
	});

	it("lets a media-read token reach the route before rejecting its missing admin scope", async () => {
		const context = usageContext(await createToken("contributor-1", ["media:read"]));
		const next = vi.fn(() => GET(context as never));

		const response = await authMiddleware(context, next);

		expect(next).toHaveBeenCalledOnce();
		expect(context.locals.tokenScopes).toEqual(["media:read"]);
		await expectError(response, 403, "INSUFFICIENT_SCOPE");
	});

	it("rejects a token without media-read scope before the route runs", async () => {
		const context = usageContext(await createToken("contributor-1", ["content:read"]));
		const next = vi.fn(async () => new Response("should not run"));

		const response = await authMiddleware(context, next);

		expect(next).not.toHaveBeenCalled();
		await expectError(response, 403, "INSUFFICIENT_SCOPE");
	});

	it("rejects an admin-scoped token whose user lacks read permissions", async () => {
		const response = await invokeThroughAuth(await createToken("subscriber-1", ["admin"]));

		await expectError(response, 403, "FORBIDDEN");
	});

	it("does not record rejected API-token use for a disabled user", async () => {
		const token = await createToken("contributor-1", ["admin"]);
		await db!.updateTable("users").set({ disabled: 1 }).where("id", "=", "contributor-1").execute();
		const next = vi.fn(async () => new Response("should not run"));

		const response = await authMiddleware(usageContext(token), next);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const stored = await db!
			.selectFrom("_emdash_api_tokens")
			.select("last_used_at")
			.where("user_id", "=", "contributor-1")
			.executeTakeFirstOrThrow();

		expect(next).not.toHaveBeenCalled();
		await expectError(response, 401, "INVALID_TOKEN");
		expect(stored.last_used_at).toBeNull();
	});

	it("rejects an unauthenticated request before the route runs", async () => {
		const context = usageContext();
		const next = vi.fn(async () => new Response("should not run"));

		const response = await authMiddleware(context, next);

		expect(next).not.toHaveBeenCalled();
		await expectError(response, 401, "NOT_AUTHENTICATED");
	});

	async function createToken(userId: string, scopes: string[]): Promise<string> {
		const result = await handleApiTokenCreate(db!, userId, {
			name: `${userId} token`,
			scopes,
		});
		if (!result.success) {
			throw new Error(`Failed to create token: ${result.error.message}`);
		}
		return result.data.token;
	}

	async function invokeThroughAuth(token: string): Promise<Response> {
		const context = usageContext(token);
		return authMiddleware(context, () => GET(context as never));
	}

	function usageContext(token?: string): AuthContext {
		const request = new Request(`http://localhost/_emdash/api/media/${mediaId}/usage`, {
			headers: token ? { Authorization: `Bearer ${token}` } : undefined,
		});

		return {
			params: { id: mediaId },
			request,
			url: new URL(request.url),
			locals: { emdash: { db: db! } },
			redirect: vi.fn(),
			session: {
				get: vi.fn(),
				set: vi.fn(),
				destroy: vi.fn(),
			},
		} as unknown as AuthContext;
	}
});

async function expectError(response: Response, status: number, code: string): Promise<void> {
	expect(response.status).toBe(status);
	const body = (await response.json()) as ApiErrorBody;
	expect(body.error.code).toBe(code);
}
