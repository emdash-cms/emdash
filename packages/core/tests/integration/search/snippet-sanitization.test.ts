import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { FTSManager } from "../../../src/search/fts-manager.js";
import { searchWithDb } from "../../../src/search/query.js";
import { createPostFixture } from "../../utils/fixtures.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

/**
 * Snippets returned by FTS5 splice literal `<mark>` markers around matched
 * terms but never escape the surrounding text. If the indexed content
 * contains characters that mean something in HTML (`<`, `>`, `&`, `"`,
 * `'`) the resulting "snippet" is unsafe to render with set:html or
 * innerHTML — both for visual integrity (broken markup, mojibake) and
 * for security (a `<script>` literal in a title becomes executable).
 *
 * The shipped contract is "snippet is safe HTML containing only <mark>
 * highlight tags." These tests pin that contract.
 */
describe("search snippet sanitization", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		repo = new ContentRepository(db);

		const registry = new SchemaRegistry(db);
		const ftsManager = new FTSManager(db);
		await registry.updateField("post", "title", { searchable: true });
		await ftsManager.enableSearch("post");
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("escapes `<` and `>` in matched content so a `<script>` title cannot execute", async () => {
		// A title containing a literal script tag — exactly the payload
		// that an attacker would aim at a poorly-escaped highlighter.
		await repo.create(
			createPostFixture({
				slug: "xss-attempt",
				status: "published",
				data: { title: "Hello <script>alert(1)</script> world" },
			}),
		);

		const { items } = await searchWithDb(db, "alert", {
			collections: ["post"],
		});

		expect(items).toHaveLength(1);
		const snippet = items[0]!.snippet ?? "";

		// The dangerous `<script>` substring must be escaped. The result
		// is allowed to contain `<mark>...</mark>` highlights, so we
		// can't just assert "no `<` chars" — we assert the script tag
		// itself cannot appear as live markup.
		expect(snippet).not.toContain("<script>");
		expect(snippet).not.toContain("</script>");
		expect(snippet).toContain("&lt;script&gt;");
	});

	it("escapes ampersands so `<3` and `&amp;` round-trip correctly", async () => {
		await repo.create(
			createPostFixture({
				slug: "ampersand",
				status: "published",
				data: { title: "Tom & Jerry: 2 < 3 forever" },
			}),
		);

		const { items } = await searchWithDb(db, "Jerry", {
			collections: ["post"],
		});

		expect(items).toHaveLength(1);
		const snippet = items[0]!.snippet ?? "";

		// Bare `&` must be escaped to `&amp;` — otherwise a downstream
		// HTML parser may interpret `& Jerry` as the start of an entity.
		expect(snippet).toContain("&amp;");
		expect(snippet).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#39;)/);

		// `<` from "2 < 3" must also be escaped, even though it's not
		// adjacent to a tag-like structure.
		expect(snippet).toContain("&lt;");
	});

	it("preserves `<mark>` highlight tags as live HTML", async () => {
		// The whole point of returning a snippet is highlighting matches.
		// Sanitization must not strip the markers we deliberately added.
		await repo.create(
			createPostFixture({
				slug: "highlight",
				status: "published",
				data: { title: "The quick brown fox jumps" },
			}),
		);

		const { items } = await searchWithDb(db, "fox", {
			collections: ["post"],
		});

		expect(items).toHaveLength(1);
		const snippet = items[0]!.snippet ?? "";

		expect(snippet).toContain("<mark>");
		expect(snippet).toContain("</mark>");
		// And the highlighted token should be the matched word.
		expect(snippet).toMatch(/<mark>fox<\/mark>/i);
	});
});
