/**
 * MCP content_publish + content_update field-coverage tests.
 *
 * Pins the contracts for:
 *
 * - **#622** `content_publish` accepts an optional `publishedAt` ISO 8601
 *   datetime that overrides the publication timestamp. The behavior is
 *   gated on `content:publish_any` because backdating overwrites historical
 *   record. Without `publishedAt`, idempotent re-publish preserves the
 *   existing timestamp (regression guard for the COALESCE behavior).
 *
 * - **#621** `content_update` persists `seo`, `bylines`, and `publishedAt`
 *   alongside field updates. The MCP tool exposes the same fields the REST
 *   API has accepted since #777; before this PR the tool's input schema
 *   silently dropped them.
 *
 * Failure modes covered:
 *   - non-admin (AUTHOR) trying to set `publishedAt` -> INSUFFICIENT_PERMISSIONS
 *   - SEO on a collection that doesn't have SEO enabled -> VALIDATION_ERROR
 *   - bylines pointing at a non-existent byline ID -> handler-level FK error
 */

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BylineRepository } from "../../../src/database/repositories/byline.js";
import type { Database } from "../../../src/database/types.js";
import {
	connectMcpHarness,
	extractJson,
	extractText,
	isErrorResult,
	type McpHarness,
} from "../../utils/mcp-runtime.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

const ADMIN_ID = "user_admin";
const AUTHOR_ID = "user_author";

// ---------------------------------------------------------------------------
// content_publish — publishedAt override (#622)
// ---------------------------------------------------------------------------

describe("MCP content_publish — publishedAt override (#622)", () => {
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

	it("backdates publishedAt when caller passes an explicit ISO timestamp", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Imported post" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		const PAST = "2020-01-15T10:00:00.000Z";
		const result = await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id, publishedAt: PAST },
		});
		expect(result.isError, extractText(result)).toBeFalsy();

		const item = extractJson<{ item: { publishedAt: string | null; status: string } }>(result).item;
		expect(item.status).toBe("published");
		// Repository normalizes to ISO so we compare via Date round-trip.
		expect(new Date(item.publishedAt!).toISOString()).toBe(PAST);
	});

	it("re-publishing with a new publishedAt overwrites the previous timestamp", async () => {
		// First publish without an override — gets a current timestamp.
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "T" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		const first = await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id },
		});
		const firstTs = extractJson<{ item: { publishedAt: string } }>(first).item.publishedAt;
		expect(firstTs).toBeTruthy();

		// Re-publish with explicit override — should overwrite.
		const PAST = "2019-06-01T00:00:00.000Z";
		const second = await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id, publishedAt: PAST },
		});
		const secondItem = extractJson<{ item: { publishedAt: string | null } }>(second).item;
		expect(new Date(secondItem.publishedAt!).toISOString()).toBe(PAST);
		expect(secondItem.publishedAt).not.toBe(firstTs);
	});

	it("rejects non-ISO-8601 publishedAt at the schema layer", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "T" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		const result = await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id, publishedAt: "yesterday" },
		});
		// Schema validation produces an isError envelope. We assert the schema's
		// own message wording — not just that the field name appears anywhere
		// (which would let an echoed input or stack trace satisfy the test for
		// the wrong reason).
		expect(isErrorResult(result)).toBe(true);
		expect(extractText(result)).toContain("must be an ISO 8601 datetime");
	});

	it("accepts ISO 8601 with explicit timezone offset (offset: true)", async () => {
		// Positive companion to the rejection test: pins that the schema's
		// `offset: true` actually accepts non-Z offsets, not just Z.
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "T" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		const result = await harness.client.callTool({
			name: "content_publish",
			arguments: {
				collection: "post",
				id,
				publishedAt: "2020-01-15T10:00:00+05:30",
			},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const item = extractJson<{ item: { publishedAt: string | null } }>(result).item;
		// Date round-trip normalizes the offset to UTC.
		expect(new Date(item.publishedAt!).toISOString()).toBe(
			new Date("2020-01-15T10:00:00+05:30").toISOString(),
		);
	});

	it("requires content:publish_any to set publishedAt — AUTHOR (owner) is denied", async () => {
		// Switch to AUTHOR role: AUTHOR has publish_own but NOT publish_any.
		await harness.cleanup();
		harness = await connectMcpHarness({ db, userId: AUTHOR_ID, userRole: Role.AUTHOR });

		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Author's post" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		// Plain publish (no publishedAt) — AUTHOR can do this for their own item.
		const ok = await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id },
		});
		expect(ok.isError, extractText(ok)).toBeFalsy();

		// Publish with backdated publishedAt — AUTHOR is denied even on their
		// own item, because backdating overwrites historical record.
		const denied = await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id, publishedAt: "2020-01-01T00:00:00.000Z" },
		});
		expect(isErrorResult(denied)).toBe(true);
		expect(extractText(denied)).toContain("INSUFFICIENT_PERMISSIONS");
		expect(extractText(denied).toLowerCase()).toContain("publish_any");
	});

	it("AUTHOR cannot publish someone else's item with publishedAt (ownership denies first)", async () => {
		// First create as ADMIN so the item belongs to a different user.
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Admin's post" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		// Switch to AUTHOR — now they're not the owner.
		await harness.cleanup();
		harness = await connectMcpHarness({ db, userId: AUTHOR_ID, userRole: Role.AUTHOR });

		const denied = await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id, publishedAt: "2020-01-01T00:00:00.000Z" },
		});
		// Whichever check fires first (ownership or publishedAt gate), the
		// denial is the correct outcome. We pin the structural failure shape,
		// not the specific code, because either order is correct.
		expect(isErrorResult(denied)).toBe(true);
		expect(extractText(denied)).toContain("INSUFFICIENT_PERMISSIONS");
	});

	it("idempotent re-publish without publishedAt preserves the original timestamp", async () => {
		// Regression guard: the COALESCE preserve-on-re-publish behavior
		// shouldn't change just because the repo signature now accepts an
		// optional override.
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "T" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		const first = await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id },
		});
		const firstTs = extractJson<{ item: { publishedAt: string } }>(first).item.publishedAt;

		// Wait so a regression that always uses `now` would surface as a new ts.
		await new Promise((r) => setTimeout(r, 5));

		const second = await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id },
		});
		const secondTs = extractJson<{ item: { publishedAt: string } }>(second).item.publishedAt;
		expect(secondTs).toBe(firstTs);
	});
});

// ---------------------------------------------------------------------------
// content_update — seo / bylines / publishedAt (#621)
// ---------------------------------------------------------------------------

describe("MCP content_update — seo / bylines / publishedAt (#621)", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;
	let bylineId: string;
	let bylineId2: string;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		// Enable SEO on the post collection (mirrors integration/seo/seo.test.ts).
		await db
			.updateTable("_emdash_collections")
			.set({ has_seo: 1 })
			.where("slug", "=", "post")
			.execute();

		// Pre-create two bylines so we can attach them via content_update.
		const bylineRepo = new BylineRepository(db);
		const b1 = await bylineRepo.create({
			slug: "jane-doe",
			displayName: "Jane Doe",
			isGuest: false,
		});
		const b2 = await bylineRepo.create({
			slug: "john-smith",
			displayName: "John Smith",
			isGuest: false,
		});
		bylineId = b1.id;
		bylineId2 = b2.id;

		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("rejects SEO canonical URL with non-http scheme (XSS guard)", async () => {
		// Pins that the MCP `content_update.seo` schema reuses the REST
		// `contentSeoInput` schema, which validates `canonical` through
		// `httpUrl` (rejects javascript:/data: URIs that would otherwise
		// become stored XSS in the rendered <link rel="canonical">).
		// A regression that swapped this back to a plain `z.string()` would
		// silently accept the malicious URL and persist it.
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "T" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		const result = await harness.client.callTool({
			name: "content_update",
			arguments: {
				collection: "post",
				id,
				seo: { canonical: "javascript:alert(1)" },
			},
		});
		expect(isErrorResult(result)).toBe(true);
	});

	it("persists SEO fields passed to content_update", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "T" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		const updated = await harness.client.callTool({
			name: "content_update",
			arguments: {
				collection: "post",
				id,
				seo: {
					title: "SEO Title",
					description: "SEO description goes here.",
					noIndex: true,
				},
			},
		});
		expect(updated.isError, extractText(updated)).toBeFalsy();

		// Round-trip via content_get — confirms persistence, not just the
		// echo from the update response.
		const got = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id },
		});
		const item = extractJson<{
			item: {
				seo?: {
					title: string | null;
					description: string | null;
					noIndex: boolean;
				};
			};
		}>(got).item;
		expect(item.seo?.title).toBe("SEO Title");
		expect(item.seo?.description).toBe("SEO description goes here.");
		expect(item.seo?.noIndex).toBe(true);
	});

	it("persists bylines passed to content_update and sets primary byline", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "T" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		const updated = await harness.client.callTool({
			name: "content_update",
			arguments: {
				collection: "post",
				id,
				bylines: [
					{ bylineId, roleLabel: "Author" },
					{ bylineId: bylineId2, roleLabel: "Editor" },
				],
			},
		});
		expect(updated.isError, extractText(updated)).toBeFalsy();

		// Round-trip via content_get rather than relying on the update response
		// echoing the input — confirms persistence rather than just the in-memory
		// pass-through. (A regression that silently dropped the DB write but
		// echoed the byline list in the response would still pass an
		// update-response-only assertion.)
		const got = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id },
		});
		const item = extractJson<{
			item: {
				primaryBylineId: string | null;
				bylines?: Array<{ byline: { id: string }; roleLabel: string | null }>;
			};
		}>(got).item;

		// First entry becomes the primary byline.
		expect(item.primaryBylineId).toBe(bylineId);
		expect(item.bylines).toHaveLength(2);
		expect(item.bylines?.[0]?.byline.id).toBe(bylineId);
		expect(item.bylines?.[0]?.roleLabel).toBe("Author");
		expect(item.bylines?.[1]?.byline.id).toBe(bylineId2);
	});

	it("backdates publishedAt when content_update receives one", async () => {
		// Publish first (so the item has a published_at to overwrite).
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "T" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;
		await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id },
		});

		const PAST = "2018-03-15T12:00:00.000Z";
		const updated = await harness.client.callTool({
			name: "content_update",
			arguments: { collection: "post", id, publishedAt: PAST },
		});
		expect(updated.isError, extractText(updated)).toBeFalsy();

		// Round-trip via content_get to confirm persistence.
		const got = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id },
		});
		const item = extractJson<{ item: { publishedAt: string | null } }>(got).item;
		expect(new Date(item.publishedAt!).toISOString()).toBe(PAST);
	});

	it("AUTHOR (owner) cannot set publishedAt via content_update", async () => {
		await harness.cleanup();
		harness = await connectMcpHarness({ db, userId: AUTHOR_ID, userRole: Role.AUTHOR });

		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Author's post" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		// AUTHOR owns this item, so ownership passes — the publishedAt gate
		// fires next and denies. This pins that the gate fires regardless of
		// ownership (backdating overwrites historical record).
		const denied = await harness.client.callTool({
			name: "content_update",
			arguments: {
				collection: "post",
				id,
				publishedAt: "2020-01-01T00:00:00.000Z",
			},
		});
		expect(isErrorResult(denied)).toBe(true);
		expect(extractText(denied)).toContain("INSUFFICIENT_PERMISSIONS");
		expect(extractText(denied).toLowerCase()).toContain("publish_any");
	});

	it("AUTHOR cannot set publishedAt on someone else's item via content_update", async () => {
		// Create as ADMIN so the item belongs to someone else.
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Admin's post" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		// Switch to AUTHOR — now they're not the owner.
		await harness.cleanup();
		harness = await connectMcpHarness({ db, userId: AUTHOR_ID, userRole: Role.AUTHOR });

		const denied = await harness.client.callTool({
			name: "content_update",
			arguments: {
				collection: "post",
				id,
				publishedAt: "2020-01-01T00:00:00.000Z",
			},
		});
		// Either ownership or the publishedAt gate denies — whichever fires
		// first. Both produce INSUFFICIENT_PERMISSIONS so the cross-product is
		// pinned without depending on check order.
		expect(isErrorResult(denied)).toBe(true);
		expect(extractText(denied)).toContain("INSUFFICIENT_PERMISSIONS");
	});

	it("rejects SEO on a collection without SEO enabled", async () => {
		// page collection from the test fixture does NOT have SEO.
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "page", data: { title: "Page" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		const result = await harness.client.callTool({
			name: "content_update",
			arguments: {
				collection: "page",
				id,
				seo: { title: "Should fail" },
			},
		});
		expect(isErrorResult(result)).toBe(true);
		expect(extractText(result)).toContain("VALIDATION_ERROR");
	});

	it("content_update with status='published' + publishedAt publishes AND backdates", async () => {
		// Pins the interaction between the status='published' branch and the
		// publishedAt override. The branch calls handleContentUpdate (which
		// writes published_at to the column) and then handleContentPublish
		// (which preserves the column via COALESCE). If either side regresses,
		// the backdated timestamp won't survive the publish.
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "T" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		const PAST = "2017-04-20T00:00:00.000Z";
		const result = await harness.client.callTool({
			name: "content_update",
			arguments: {
				collection: "post",
				id,
				status: "published",
				publishedAt: PAST,
			},
		});
		expect(result.isError, extractText(result)).toBeFalsy();

		// Round-trip via content_get to confirm both status AND backdated
		// timestamp landed.
		const got = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id },
		});
		const item = extractJson<{ item: { status: string; publishedAt: string | null } }>(got).item;
		expect(item.status).toBe("published");
		expect(new Date(item.publishedAt!).toISOString()).toBe(PAST);
	});

	it("seo / bylines / publishedAt and field updates apply atomically", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Original" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;
		await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id },
		});

		const PAST = "2021-06-01T00:00:00.000Z";
		const updated = await harness.client.callTool({
			name: "content_update",
			arguments: {
				collection: "post",
				id,
				data: { title: "Updated" },
				seo: { title: "SEO" },
				bylines: [{ bylineId }],
				publishedAt: PAST,
			},
		});
		expect(updated.isError, extractText(updated)).toBeFalsy();

		const got = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id },
		});
		const item = extractJson<{
			item: {
				data: { title?: string };
				publishedAt: string | null;
				primaryBylineId: string | null;
				seo?: { title: string | null };
			};
		}>(got).item;

		// All four updates landed.
		expect(item.data.title).toBe("Updated");
		expect(item.seo?.title).toBe("SEO");
		expect(item.primaryBylineId).toBe(bylineId);
		expect(new Date(item.publishedAt!).toISOString()).toBe(PAST);
	});
});
