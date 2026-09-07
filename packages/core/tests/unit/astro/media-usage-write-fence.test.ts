import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

import { onRequest } from "../../../src/astro/middleware/media-usage-write-fence.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("media usage activation write fence", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it.each([
		"/_emdash/api/content/posts",
		"/_emdash/api/schema/collections",
		"/_emdash/api/admin/media-usage/repair",
		"/_emdash/api/revisions/revision-1/restore",
		"/_emdash/api/import/wordpress/execute",
		"/_emdash/api/mcp",
	])("rejects a state-changing %s request while activation is incomplete", async (pathname) => {
		await setActivationState("activating");
		const next = vi.fn(async () => new Response(null, { status: 204 }));

		const response = await invoke(pathname, "POST", next);

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			success: false,
			error: {
				code: "MEDIA_USAGE_ACTIVATION_IN_PROGRESS",
				message: "Media usage activation is in progress",
			},
		});
		expect(next).not.toHaveBeenCalled();
	});

	it.each(["expanded", "active"])("allows content writes while activation is %s", async (state) => {
		await setActivationState(state);
		const next = vi.fn(async () => new Response(null, { status: 204 }));

		const response = await invoke("/_emdash/api/content/posts", "POST", next);

		expect(response.status).toBe(204);
		expect(next).toHaveBeenCalledOnce();
	});

	it("does not fence reads or unrelated writes", async () => {
		await setActivationState("activating");
		const next = vi.fn(async () => new Response(null, { status: 204 }));

		expect((await invoke("/_emdash/api/content/posts", "GET", next)).status).toBe(204);
		expect((await invoke("/_emdash/api/media", "POST", next)).status).toBe(204);
		expect((await invoke("/_emdash/api/plugins/example/write", "POST", next)).status).toBe(204);
		expect(next).toHaveBeenCalledTimes(3);
	});

	async function setActivationState(state: string): Promise<void> {
		await db
			.updateTable("_emdash_media_usage_activation")
			.set({ state })
			.where("task_key", "=", "incremental_capture")
			.execute();
	}

	async function invoke(
		pathname: string,
		method: string,
		next: () => Promise<Response>,
	): Promise<Response> {
		const url = new URL(pathname, "https://example.com");
		return onRequest(
			{
				request: new Request(url, { method }),
				url,
				locals: { emdash: { db } },
			} as never,
			next,
		);
	}
});
