/**
 * Creating or duplicating an entry produces a draft, which no public page
 * renders, so neither route purges the route cache.
 */

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as duplicateContent } from "../../../src/astro/routes/api/content/[collection]/[id]/duplicate.js";
import { POST as createContent } from "../../../src/astro/routes/api/content/[collection]/index.js";
import type { Database } from "../../../src/database/types.js";
import { createTestRuntime, handlersFromRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

type CreateContext = Parameters<typeof createContent>[0];
type DuplicateContext = Parameters<typeof duplicateContent>[0];

describe("content create and duplicate routes", () => {
	let db: Kysely<Database>;
	let emdash: ReturnType<typeof handlersFromRuntime>;
	const user = { id: "user_admin", role: Role.ADMIN };
	const invalidate = vi.fn(async () => {});
	const cache = { enabled: true, invalidate };

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		emdash = handlersFromRuntime(createTestRuntime(db));
		invalidate.mockClear();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("do not purge the route cache for the drafts they create", async () => {
		const created = await createContent({
			params: { collection: "post" },
			request: new Request("http://localhost/_emdash/api/content/post", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ data: { title: "Draft" } }),
			}),
			locals: { emdash, user },
			cache,
		} as unknown as CreateContext);
		expect(created.status).toBe(201);
		const { data } = (await created.json()) as { data: { item: { id: string; status: string } } };
		expect(data.item.status).toBe("draft");

		const duplicated = await duplicateContent({
			params: { collection: "post", id: data.item.id },
			request: new Request(`http://localhost/_emdash/api/content/post/${data.item.id}/duplicate`, {
				method: "POST",
			}),
			locals: { emdash, user },
			cache,
		} as unknown as DuplicateContext);
		expect(duplicated.status).toBe(201);

		expect(invalidate).not.toHaveBeenCalled();
	});
});
