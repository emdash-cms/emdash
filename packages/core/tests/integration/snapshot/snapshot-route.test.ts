import { sql } from "kysely";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Snapshot } from "../../../src/api/handlers/snapshot.js";
import { GET } from "../../../src/astro/routes/api/snapshot.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabaseWithCollections } from "../../utils/test-db.js";

const SECRET = "test-preview-secret";

async function signatureHeader(source: string): Promise<string> {
	const exp = Math.floor(Date.now() / 1000) + 3600;
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const buffer = await crypto.subtle.sign("HMAC", key, encoder.encode(`${source}:${exp}`));
	const sig = Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
	return `${source}:${exp}:${sig}`;
}

describe("GET /_emdash/api/snapshot", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		vi.stubEnv("EMDASH_PREVIEW_SECRET", SECRET);
		db = await setupTestDatabaseWithCollections();
		await sql`
			INSERT INTO ec_post (
				id, slug, status, title, content, translation_group, created_at, updated_at, version
			)
			VALUES
				(
					'p1', 'live', 'published', 'Live',
					'{"provider":"local","id":"media-live","meta":{"storageKey":"public/live.webp"}}',
					'group-live', datetime('now'), datetime('now'), 1
				),
				(
					'p2', 'wip', 'draft', 'Work in Progress',
					'{"provider":"local","id":"media-draft","meta":{"storageKey":"private/draft.webp"}}',
					'group-draft', datetime('now'), datetime('now'), 1
				)
		`.execute(db);
		await sql`
			INSERT INTO revisions (id, collection, entry_id, data)
			VALUES ('r1', 'post', 'p2', '{"title":"Work in Progress"}')
		`.execute(db);
		await sql`
			INSERT INTO _emdash_seo (collection, content_id, seo_title)
			VALUES ('post', 'p1', 'Live SEO'), ('post', 'p2', 'Draft SEO secret')
		`.execute(db);
		await sql`
			INSERT INTO taxonomies (id, name, slug, label, locale, translation_group)
			VALUES
				('term-live', 'tags', 'live-tag', 'Live tag', 'en', 'term-group-live'),
				('term-draft', 'tags', 'draft-tag', 'Draft tag secret', 'en', 'term-group-draft')
		`.execute(db);
		await sql`
			INSERT INTO content_taxonomies (collection, entry_id, taxonomy_id)
			VALUES
				('post', 'group-live', 'term-group-live'),
				('post', 'group-draft', 'term-group-draft')
		`.execute(db);
		await sql`
			INSERT INTO media (id, filename, mime_type, storage_key)
			VALUES
				('media-live', 'live.webp', 'image/webp', 'public/live.webp'),
				('media-draft', 'draft.webp', 'image/webp', 'private/draft.webp'),
				('media-unused', 'unused.webp', 'image/webp', 'private/unused.webp')
		`.execute(db);
		await sql`
			INSERT INTO _emdash_sections (id, slug, title, content)
			VALUES ('section-live', 'site-section', 'Site section', '[{"children":[]}]')
		`.execute(db);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await db.destroy();
	});

	async function request(options: { query?: string; signature?: string; role?: number }) {
		const url = new URL(`https://mysite.com/_emdash/api/snapshot${options.query ?? ""}`);
		const headers = options.signature ? { "X-Preview-Signature": options.signature } : undefined;
		const response = await GET({
			request: new Request(url, { headers }),
			url,
			locals: {
				emdash: { db, config: {} },
				user: options.role === undefined ? undefined : { id: "u1", role: options.role },
			},
			session: undefined,
		} as never);
		const body = response.ok ? ((await response.json()) as { data: Snapshot }).data : null;
		return { status: response.status, snapshot: body };
	}

	it("serves only published content to a preview signature, even with drafts=true", async () => {
		const { status, snapshot } = await request({
			query: "?drafts=true",
			signature: await signatureHeader("https://mysite.com"),
		});
		expect(status).toBe(200);
		expect(snapshot?.tables.ec_post?.map((row) => row.id)).toEqual(["p1"]);
		expect(snapshot?.tables.revisions).toBeUndefined();
		expect(snapshot?.tables._emdash_seo?.map((row) => row.content_id)).toEqual(["p1"]);
		expect(snapshot?.tables.content_taxonomies).toMatchObject([
			{ collection: "post", entry_id: "group-live", taxonomy_id: "term-group-live" },
		]);
		expect(snapshot?.tables.taxonomies?.map((row) => row.id)).toEqual(["term-live"]);
		expect(snapshot?.tables.media?.map((row) => row.id)).toEqual(["media-live"]);
		expect(snapshot?.tables._emdash_sections?.map((row) => row.id)).toEqual(["section-live"]);
		expect(JSON.stringify(snapshot)).not.toContain("Draft SEO secret");
		expect(JSON.stringify(snapshot)).not.toContain("Draft tag secret");
		expect(JSON.stringify(snapshot)).not.toContain("private/draft.webp");
		expect(JSON.stringify(snapshot)).not.toContain("private/unused.webp");
	});

	it("leaves revision payloads out of a published-only snapshot", async () => {
		const { status, snapshot } = await request({
			signature: await signatureHeader("https://mysite.com"),
		});
		expect(status).toBe(200);
		expect(snapshot?.tables.revisions).toBeUndefined();
		expect(snapshot?.schema.revisions).toBeDefined();
	});

	it("includes drafts and revisions for an editor who asks for them", async () => {
		const { status, snapshot } = await request({ query: "?drafts=true", role: 40 });
		expect(status).toBe(200);
		expect(snapshot?.tables.ec_post?.map((row) => row.id).toSorted()).toEqual(["p1", "p2"]);
		expect(snapshot?.tables.revisions?.map((row) => row.id)).toEqual(["r1"]);
		expect(snapshot?.tables._emdash_seo?.map((row) => row.content_id).toSorted()).toEqual([
			"p1",
			"p2",
		]);
		expect(snapshot?.tables.content_taxonomies).toHaveLength(2);
		expect(snapshot?.tables.media).toHaveLength(3);
		expect(snapshot?.tables._emdash_sections).toHaveLength(1);
	});

	it("rejects an anonymous request", async () => {
		const { status } = await request({});
		expect(status).toBe(401);
	});
});
