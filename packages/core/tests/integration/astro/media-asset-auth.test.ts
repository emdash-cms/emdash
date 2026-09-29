import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

vi.mock("virtual:emdash/auth", () => ({ authenticate: vi.fn() }), { virtual: true });
vi.mock("virtual:emdash/config", () => ({ default: {} }), { virtual: true });

import { handleApiTokenCreate } from "../../../src/api/handlers/api-tokens.js";
import { onRequest as authMiddleware } from "../../../src/astro/middleware/auth.js";
import { GET } from "../../../src/astro/routes/api/media/asset/[id]/[filename].js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import { LocalStorage } from "../../../src/storage/local.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

type AuthContext = Parameters<typeof authMiddleware>[0];

describe("opaque media asset authentication", () => {
	let db: Kysely<Database>;
	let directory: string;
	let storage: LocalStorage;
	let mediaId: string;
	const storageKey = "private/authenticated.bin";

	beforeEach(async () => {
		db = await setupTestDatabase();
		directory = await mkdtemp(join(tmpdir(), "emdash-media-asset-auth-"));
		storage = new LocalStorage({ directory, baseUrl: "https://media.example.test" });
		await storage.upload({
			key: storageKey,
			body: new Uint8Array([0, 255, 17, 42]),
			contentType: "application/octet-stream",
		});
		await db
			.insertInto("users")
			.values({
				id: "subscriber-1",
				email: "subscriber@example.com",
				name: "Subscriber",
				role: Role.SUBSCRIBER,
				email_verified: 1,
			})
			.execute();
		mediaId = (
			await new MediaRepository(db).create({
				filename: "authenticated.bin",
				mimeType: "application/octet-stream",
				size: 4,
				storageKey,
			})
		).id;
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		await rm(directory, { recursive: true, force: true });
	});

	it("rejects a logged-out request before the route can query media", async () => {
		const context = assetContext();
		const next = vi.fn(() => GET(context as never));
		const response = await authMiddleware(context, next);
		expect(response.status).toBe(401);
		expect(next).not.toHaveBeenCalled();
	});

	it("serves the opaque URL to a media-read token", async () => {
		const token = await createToken(["media:read"]);
		const context = assetContext(token);
		const next = vi.fn(() => GET(context as never));
		const response = await authMiddleware(context, next);
		expect(next).toHaveBeenCalledOnce();
		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 255, 17, 42]));
		expect(context.request.url).not.toContain(storageKey);
	});

	it("rejects a token without media-read scope before the route runs", async () => {
		const token = await createToken(["content:read"]);
		const context = assetContext(token);
		const next = vi.fn(() => GET(context as never));
		const response = await authMiddleware(context, next);
		expect(response.status).toBe(403);
		expect(next).not.toHaveBeenCalled();
	});

	async function createToken(scopes: string[]): Promise<string> {
		const result = await handleApiTokenCreate(db, "subscriber-1", {
			name: "media asset test",
			scopes,
		});
		if (!result.success) throw new Error(result.error.message);
		return result.data.token;
	}

	function assetContext(token?: string): AuthContext {
		const request = new Request(
			`http://localhost/_emdash/api/media/asset/${mediaId}/authenticated.bin`,
			{ headers: token ? { Authorization: `Bearer ${token}` } : undefined },
		);
		return {
			params: { id: mediaId, filename: "authenticated.bin" },
			request,
			url: new URL(request.url),
			locals: { emdash: { db, storage } },
			redirect: vi.fn(),
			session: {
				get: vi.fn(),
				set: vi.fn(),
				destroy: vi.fn(),
			},
		} as unknown as AuthContext;
	}
});
