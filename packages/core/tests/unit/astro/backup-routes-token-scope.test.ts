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
import { GET as exportBackup } from "../../../src/astro/routes/api/settings/backups/export.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

type AuthContext = Parameters<typeof authMiddleware>[0];

interface ApiErrorBody {
	error: {
		code: string;
		message: string;
	};
}

describe("backup routes token scope", () => {
	let db: Kysely<Database> | undefined;

	beforeEach(async () => {
		db = await setupTestDatabase();
		await db
			.insertInto("users")
			.values({
				id: "admin-1",
				email: "admin@example.com",
				name: "Admin",
				role: Role.ADMIN,
				email_verified: 1,
			})
			.execute();
	});

	afterEach(async () => {
		if (db) await teardownTestDatabase(db);
		db = undefined;
	});

	it("rejects a settings:read token on the export route before it runs", async () => {
		const context = requestContext(
			"/_emdash/api/settings/backups/export",
			await createToken(["settings:read"]),
		);
		const next = vi.fn(async () => new Response("should not run"));

		const response = await authMiddleware(context, next);

		expect(next).not.toHaveBeenCalled();
		await expectError(response, 403, "INSUFFICIENT_SCOPE");
	});

	it("rejects a settings:read token on archive downloads before the route runs", async () => {
		const context = requestContext(
			"/_emdash/api/settings/backups/archives/emdash-backup-2026-01-01T00-00-00-0123abcd.json",
			await createToken(["settings:read"]),
		);
		const next = vi.fn(async () => new Response("should not run"));

		const response = await authMiddleware(context, next);

		expect(next).not.toHaveBeenCalled();
		await expectError(response, 403, "INSUFFICIENT_SCOPE");
	});

	it("allows an admin-scoped token for an admin to export", async () => {
		const context = requestContext(
			"/_emdash/api/settings/backups/export",
			await createToken(["admin"]),
		);

		const response = await authMiddleware(context, () => exportBackup(context as never));

		expect(response.status).toBe(200);
		expect(((await response.json()) as { format: string }).format).toBe("emdash-backup");
	});

	it("still lets a settings:read token read general settings", async () => {
		const context = requestContext("/_emdash/api/settings", await createToken(["settings:read"]));
		const next = vi.fn(async () => new Response("ok"));

		const response = await authMiddleware(context, next);

		expect(next).toHaveBeenCalledOnce();
		expect(response.status).toBe(200);
	});

	async function createToken(scopes: string[]): Promise<string> {
		const result = await handleApiTokenCreate(db!, "admin-1", {
			name: "admin token",
			scopes,
		});
		if (!result.success) {
			throw new Error(`Failed to create token: ${result.error.message}`);
		}
		return result.data.token;
	}

	function requestContext(path: string, token: string): AuthContext {
		const request = new Request(`http://localhost${path}`, {
			headers: { Authorization: `Bearer ${token}` },
		});

		return {
			params: {},
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
