/**
 * Regression for issue #867: seed data containing Portable Text blocks
 * without `_key` properties caused autosave validation errors after the
 * site was bootstrapped.
 *
 * Several first-party templates (blog, portfolio, starter) ship seed
 * content where each PT block omits `_key`. The Zod schema generated for
 * `portableText` fields requires `_key: z.string()` on every block, so
 * any update to a content entry whose body still held the un-keyed seed
 * data was rejected with `VALIDATION_ERROR: content.0._key: Invalid
 * input: expected string, received undefined; ...` -- making the entry
 * effectively unsavable in the admin UI.
 *
 * `applySeed()` must inject a stable `_key` for every PT-shaped object
 * (anything carrying a `_type`) before persisting so the values that
 * land in the database are valid against the same schema the API uses
 * to validate updates.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { validateContentData } from "../../src/api/handlers/validation.js";
import type { Database } from "../../src/database/types.js";
import { applySeed } from "../../src/seed/apply.js";
import type { SeedFile } from "../../src/seed/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../utils/test-db.js";

/**
 * Recursively collect every object in `value` that carries a `_type`
 * field. We use this to assert that every PT-shaped object ends up with
 * a `_key` after seeding.
 */
function collectTypedNodes(value: unknown, out: Array<Record<string, unknown>> = []) {
	if (Array.isArray(value)) {
		for (const item of value) collectTypedNodes(item, out);
		return out;
	}
	if (value !== null && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		if (typeof obj._type === "string") out.push(obj);
		for (const v of Object.values(obj)) collectTypedNodes(v, out);
	}
	return out;
}

function seedWithKeylessPortableText(): SeedFile {
	return {
		version: "1",
		collections: [
			{
				slug: "posts",
				label: "Posts",
				labelSingular: "Post",
				fields: [
					{ slug: "title", label: "Title", type: "string" },
					{ slug: "content", label: "Content", type: "portableText" },
				],
			},
		],
		content: {
			posts: [
				{
					id: "post-1",
					slug: "hello-world",
					status: "published",
					data: {
						title: "Hello World",
						// Mirrors templates/portfolio/seed/seed.json exactly: no
						// `_key` on blocks, spans, or markDefs.
						content: [
							{
								_type: "block",
								style: "normal",
								children: [{ _type: "span", text: "First paragraph." }],
							},
							{
								_type: "block",
								style: "h2",
								children: [{ _type: "span", text: "A heading" }],
							},
							{
								_type: "block",
								style: "normal",
								markDefs: [{ _type: "link", href: "https://example.com" }],
								children: [{ _type: "span", text: "Linked text", marks: ["m1"] }],
							},
						],
					},
				},
			],
		},
	};
}

describe("applySeed normalizes Portable Text keys (issue #867)", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("injects _key on every PT-typed node when seeding content", async () => {
		await applySeed(db, seedWithKeylessPortableText(), { includeContent: true });

		const row = await db
			// biome-ignore lint/suspicious/noExplicitAny: dynamic content table
			.selectFrom("ec_posts" as any)
			.selectAll()
			.where("slug", "=", "hello-world")
			.executeTakeFirstOrThrow();

		const r = row as Record<string, unknown>;
		const content = JSON.parse(r.content as string);
		const typed = collectTypedNodes(content);

		// Sanity: there should be blocks, spans, and a markDef.
		expect(typed.length).toBeGreaterThan(0);

		for (const node of typed) {
			expect(node._key, `missing _key on ${JSON.stringify(node)}`).toEqual(expect.any(String));
			expect((node._key as string).length).toBeGreaterThan(0);
		}

		// Keys must be unique within a single content entry so the editor
		// can use them as React keys / stable references.
		const keys = typed.map((n) => n._key as string);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("seeded content survives the same validator the autosave endpoint uses", async () => {
		// This is the actual bug shape: the admin UI re-sends the data
		// it loaded from the server on autosave. If the server stored
		// keyless blocks, that round-trip fails.
		await applySeed(db, seedWithKeylessPortableText(), { includeContent: true });

		const row = await db
			// biome-ignore lint/suspicious/noExplicitAny: dynamic content table
			.selectFrom("ec_posts" as any)
			.selectAll()
			.where("slug", "=", "hello-world")
			.executeTakeFirstOrThrow();

		const r = row as Record<string, unknown>;
		const storedContent = JSON.parse(r.content as string);

		// Simulate what the admin UI sends back unchanged on autosave
		// when the user edits a *different* field (e.g. featured image).
		const result = await validateContentData(
			db,
			"posts",
			{ title: "Hello World", content: storedContent },
			{ partial: true },
		);

		expect(result).toEqual({ ok: true });
	});

	it("preserves explicit _key values when the seed already provides them", async () => {
		const seed = seedWithKeylessPortableText();
		// Mutate one block to carry a caller-supplied key. The
		// normalization must be idempotent: existing keys are kept,
		// only missing ones are filled in.
		const post = seed.content!.posts![0]!;
		const blocks = post.data.content as Array<Record<string, unknown>>;
		blocks[0]!._key = "preserved-key-abc";

		await applySeed(db, seed, { includeContent: true });

		const row = await db
			// biome-ignore lint/suspicious/noExplicitAny: dynamic content table
			.selectFrom("ec_posts" as any)
			.selectAll()
			.where("slug", "=", "hello-world")
			.executeTakeFirstOrThrow();

		const r = row as Record<string, unknown>;
		const content = JSON.parse(r.content as string) as Array<Record<string, unknown>>;
		expect(content[0]!._key).toBe("preserved-key-abc");
	});
});
