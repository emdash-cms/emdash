/**
 * MCP concurrency tests.
 *
 * Maps to MCP_BUGS.md #8: parallel MCP calls on the same authenticated
 * session return spurious 401s. Some calls in a batch succeed; others
 * fail with `Streamable HTTP error: Server returned 401 after successful
 * authentication`. Retrying serially: all succeed.
 *
 * The bug as reported lives in the production HTTP transport layer —
 * specifically the auth middleware path through `astro/middleware/auth.ts`.
 * The InMemoryTransport used by these integration tests doesn't exercise
 * that code path, so true reproduction needs a live HTTP server (which
 * lives in `tests/integration/smoke/site-matrix-smoke.test.ts`).
 *
 * What we CAN test here is the runtime + handler + tool dispatch under
 * concurrent invocation: shared mutable state, race conditions in the
 * MCP server's tool registration, draft revision creation under load,
 * and so on. If the in-memory path is racy, the bug surface is wider
 * than just the HTTP transport.
 *
 * **Expected fix:** for the HTTP-level 401 race, the auth handler should
 * not mutate per-request session state in a way that's visible across
 * concurrent requests. For runtime-level races, sequential semantics
 * should hold even when calls overlap.
 *
 * The smoke-test counterpart for #8 (parallel HTTP calls against a real
 * dev server) is added separately in
 * `tests/integration/smoke/site-matrix-smoke.test.ts`.
 */

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../../src/database/types.js";
import {
	connectMcpHarness,
	extractJson,
	extractText,
	type McpHarness,
} from "../../utils/mcp-runtime.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

const ADMIN_ID = "user_admin";

describe("MCP concurrency — in-memory transport (bug #8 partial)", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("14 parallel read calls all succeed (no spurious failures)", async () => {
		// Mirrors the failure mode reported in MCP_BUGS.md #8 — ~14 batched
		// calls, several came back as spurious 401s. Over the in-memory
		// transport the auth path is bypassed, so a failure here would
		// indicate the bug is broader than the HTTP layer.
		// Each iteration must call the tool fresh — .fill() would reuse one
		// Promise. `void i` keeps the lint rule from misreading the callback
		// as constant.
		const callPromises = Array.from({ length: 14 }, (_, i) => {
			void i;
			return harness.client.callTool({ name: "schema_list_collections", arguments: {} });
		});

		const results = await Promise.all(callPromises);
		for (const result of results) {
			expect(result.isError, extractText(result)).toBeFalsy();
		}
	});

	it("mixed read/write calls in parallel maintain correctness", async () => {
		// 5 creates + 5 lists running concurrently. Final list count must
		// equal initial count + creates that succeeded.
		const initial = await harness.client.callTool({
			name: "content_list",
			arguments: { collection: "post" },
		});
		const initialCount = extractJson<{ items: unknown[] }>(initial).items.length;

		const work = [
			...Array.from({ length: 5 }, (_, i) =>
				harness.client.callTool({
					name: "content_create",
					arguments: { collection: "post", data: { title: `parallel ${i}` } },
				}),
			),
			...Array.from({ length: 5 }, (_, i) => {
				void i;
				return harness.client.callTool({
					name: "content_list",
					arguments: { collection: "post" },
				});
			}),
		];

		const results = await Promise.all(work);

		// Count successful creates
		const createsSuccessful = results
			.slice(0, 5)
			.filter((r) => !(r as { isError?: boolean }).isError).length;
		expect(createsSuccessful).toBe(5);

		// Final list should reflect all creates
		const final = await harness.client.callTool({
			name: "content_list",
			arguments: { collection: "post" },
		});
		const finalCount = extractJson<{ items: unknown[] }>(final).items.length;
		expect(finalCount).toBe(initialCount + 5);
	});

	it("parallel updates to the same item don't corrupt state", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Original" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		// 10 concurrent updates with different titles
		const work = Array.from({ length: 10 }, (_, i) =>
			harness.client.callTool({
				name: "content_update",
				arguments: { collection: "post", id, data: { title: `update ${i}` } },
			}),
		);

		const results = await Promise.all(work);
		for (const result of results) {
			expect(result.isError, extractText(result)).toBeFalsy();
		}

		// Final state should be a valid title from one of the updates,
		// not corrupted or empty.
		const got = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id },
		});
		const item = extractJson<{ item: { title?: unknown; data?: { title?: unknown } } }>(got).item;
		const title = item.data?.title ?? item.title;
		expect(typeof title).toBe("string");
		expect(title).toMatch(/^(Original|update \d)$/);
	});

	it("parallel calls don't leak data across users", async () => {
		// Two harnesses on the same DB, one ADMIN, one CONTRIBUTOR.
		// Concurrent reads should each see their own permitted view.
		const userTwo = await connectMcpHarness({
			db,
			userId: "user_contrib",
			userRole: Role.CONTRIBUTOR,
		});

		try {
			// Admin creates an item
			const created = await harness.client.callTool({
				name: "content_create",
				arguments: { collection: "post", data: { title: "by admin" } },
			});
			expect(created.isError, extractText(created)).toBeFalsy();
			const id = extractJson<{ item: { id: string } }>(created).item.id;

			// 10 concurrent updates: 5 from admin (allowed), 5 from contributor
			// who isn't the author (denied). All admin updates should succeed,
			// all contributor updates should fail — no cross-contamination.
			const adminWork = Array.from({ length: 5 }, (_, i) =>
				harness.client.callTool({
					name: "content_update",
					arguments: { collection: "post", id, data: { title: `admin ${i}` } },
				}),
			);
			const contribWork = Array.from({ length: 5 }, (_, i) =>
				userTwo.client.callTool({
					name: "content_update",
					arguments: { collection: "post", id, data: { title: `contrib ${i}` } },
				}),
			);

			const [adminResults, contribResults] = await Promise.all([
				Promise.all(adminWork),
				Promise.all(contribWork),
			]);

			for (const r of adminResults) {
				expect(r.isError, extractText(r)).toBeFalsy();
			}
			for (const r of contribResults) {
				expect(r.isError).toBe(true);
			}
		} finally {
			await userTwo.cleanup();
		}
	});
});
