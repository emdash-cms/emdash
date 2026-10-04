import { experimental_AstroContainer as AstroContainer } from "astro/container";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import CommentForm from "../../src/components/CommentForm.astro";
import Comments from "../../src/components/Comments.astro";
import { CommentRepository } from "../../src/database/repositories/comment.js";
import type { Database } from "../../src/database/types.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../utils/test-db.js";

let db: Kysely<Database>;

beforeEach(async () => {
	db = await setupTestDatabase();
	await new SchemaRegistry(db).createCollection({
		slug: "notes",
		label: "Notes",
		labelSingular: "Note",
		commentsEnabled: true,
	});
	await new CommentRepository(db).create({
		collection: "notes",
		contentId: "note-1",
		authorName: "Ada",
		authorEmail: "ada@example.com",
		body: "Hallo",
		status: "approved",
	});
});

afterEach(async () => {
	await teardownTestDatabase(db);
});

async function render(
	component: Parameters<AstroContainer["renderToString"]>[0],
	props: Record<string, unknown>,
) {
	const container = await AstroContainer.create();
	const html = await runWithContext({ editMode: false, db }, () =>
		container.renderToString(component, {
			props: { collection: "notes", contentId: "note-1", ...props },
		}),
	);
	return html.replace(/ data-astro-cid-\w+/g, "");
}

describe("Comments labels", () => {
	test("renders the English defaults and en-US dates without labels", async () => {
		const html = await render(Comments, { reactions: true });

		expect(html).toContain("1 Comment</h3>");
		expect(html).toContain(">Like</span>");
		expect(html).toMatch(/datetime="[^"]+">\s*[A-Z][a-z]+ \d{1,2}, \d{4}/);
	});

	test("renders custom labels and dates in the given locale", async () => {
		const html = await render(Comments, {
			reactions: true,
			locale: "de-CH",
			labels: {
				heading: (count: number) => `${count} Kommentar`,
				like: "Gefällt mir",
			},
		});

		expect(html).toContain("1 Kommentar</h3>");
		expect(html).toContain(">Gefällt mir</span>");
		expect(html).toMatch(/datetime="[^"]+">\s*\d{1,2}\. [A-ZÄÖÜ][a-zäöü]+ \d{4}/);
	});

	test("keeps the defaults for labels passed as undefined", async () => {
		const html = await render(Comments, {
			reactions: true,
			labels: { heading: undefined, like: undefined },
		});

		expect(html).toContain("1 Comment</h3>");
		expect(html).toContain(">Like</span>");
	});

	test("falls back to en-US for a locale Intl does not accept", async () => {
		const html = await render(Comments, { locale: "not a locale" });

		expect(html).toMatch(/datetime="[^"]+">\s*[A-Z][a-z]+ \d{1,2}, \d{4}/);
	});
});

describe("CommentForm labels", () => {
	test("renders custom field labels and passes status text to the script", async () => {
		const html = await render(CommentForm, {
			labels: {
				name: "Dein Name",
				email: undefined,
				comment: "Kommentar",
				submit: "Absenden",
				pending: "Wird geprüft",
			},
		});

		expect(html).toContain("<span>Dein Name</span>");
		expect(html).toContain("<span>Kommentar</span>");
		expect(html).toMatch(/class="ec-comment-form-submit"[^>]*>\s*Absenden\s*<\/button>/);
		expect(html).toContain("&quot;pending&quot;:&quot;Wird geprüft&quot;");
		expect(html).toContain("<span>Email</span>");
	});
});
