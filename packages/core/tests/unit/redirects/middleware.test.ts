import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RedirectRepository } from "../../../src/database/repositories/redirect.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

vi.mock("astro:middleware", () => ({
	defineMiddleware: <T>(fn: T) => fn,
}));

vi.mock("../../../src/loader.js", () => ({
	getDb: vi.fn(),
}));

import { onRequest } from "../../../src/astro/middleware/redirect.js";
import { getDb } from "../../../src/loader.js";

describe("redirect middleware", () => {
	let db: Kysely<Database>;
	let repo: RedirectRepository;

	beforeEach(async () => {
		db = await setupTestDatabase();
		repo = new RedirectRepository(db);
		vi.mocked(getDb).mockResolvedValue(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		vi.restoreAllMocks();
	});

	it("uses the loader database fallback for anonymous public requests", async () => {
		await repo.create({
			source: "/coming-soon/",
			destination: "/blog/coming-soon/",
			type: 301,
			enabled: true,
		});

		const next = vi.fn(async () => new Response("not found", { status: 404 }));
		const response = await onRequest(
			{
				url: new URL("https://example.com/coming-soon/"),
				locals: {},
				request: new Request("https://example.com/coming-soon/"),
				redirect: (location: string, status: number) =>
					new Response(null, {
						status,
						headers: { location },
					}),
			} as never,
			next,
		);

		expect(next).not.toHaveBeenCalled();
		expect(response.status).toBe(301);
		expect(response.headers.get("location")).toBe("/blog/coming-soon/");
	});
});
