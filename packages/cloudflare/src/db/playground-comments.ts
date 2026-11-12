import type { Database, EditorialActor } from "emdash";
import { handleEditorialCommentCreate, handleEditorialThreadCreate, locateQuote } from "emdash";
import { type Kysely, sql } from "kysely";

const REVIEWER: EditorialActor & { name: string; email: string } = {
	id: "playground-reviewer",
	name: "Sam Rivera",
	email: "sam@playground.emdashcms.com",
	role: 40,
};
const VISITOR_ID = "playground-admin";

const POST_SLUG = "building-for-the-long-term";

const TEXT_THREAD = {
	quote: "you spend more time migrating than building",
	body: "Strong line. Could we follow it with a concrete example from a real migration?",
	reply: "Agreed. I'll add the jQuery-to-React rewrite we did last year.",
};
const EXCERPT_THREAD_BODY =
	"The excerpt undersells the piece. Could it lead with the point about boring technology?";

/**
 * The seed's Portable Text has no block keys, and text threads need them to
 * stay attached, so the example post gets stable ones.
 */
function withBlockKeys(value: unknown): unknown[] {
	if (!Array.isArray(value)) return [];
	return value.map((block: unknown, index) =>
		typeof block === "object" && block !== null && !("_key" in block)
			? { ...block, _key: `pg${index}` }
			: block,
	);
}

/**
 * Example editorial threads on a seeded post, from a demo reviewer, so
 * visitors find comments in the margin and can reply, resolve or add their own.
 */
export async function seedPlaygroundComments(db: Kysely<Database>, now: string): Promise<void> {
	await db
		.insertInto("users")
		.values({
			id: REVIEWER.id,
			email: REVIEWER.email,
			name: REVIEWER.name,
			role: REVIEWER.role,
			email_verified: 1,
			created_at: now,
			updated_at: now,
		})
		.onConflict((conflict) => conflict.column("id").doNothing())
		.execute();

	const post = await sql<{ id: string; content: string | null }>`
		SELECT id, content FROM ec_posts
		WHERE slug = ${POST_SLUG} AND locale = ${"en"} AND deleted_at IS NULL
	`.execute(db);
	const row = post.rows[0];
	if (!row) return;
	const entry = { collection: "posts", id: row.id };

	// Initialization reruns until setup completes, so earlier attempts may have seeded already.
	const seeded = await db
		.selectFrom("_emdash_editorial_threads")
		.select("id")
		.where("collection", "=", entry.collection)
		.where("entry_id", "=", entry.id)
		.where("created_by", "=", REVIEWER.id)
		.executeTakeFirst();
	if (seeded) return;

	const content = withBlockKeys(row.content ? JSON.parse(row.content) : []);
	await sql`UPDATE ec_posts SET content = ${JSON.stringify(content)} WHERE id = ${row.id}`.execute(
		db,
	);
	const found = locateQuote(content, "content", TEXT_THREAD.quote);
	if (found.status === "found") {
		const thread = await handleEditorialThreadCreate(db, REVIEWER, entry, {
			anchor: found.anchor,
			body: TEXT_THREAD.body,
		});
		if (thread.success) {
			await handleEditorialCommentCreate(db, { id: VISITOR_ID, role: 50 }, entry, thread.data.id, {
				body: TEXT_THREAD.reply,
			});
		}
	}

	await handleEditorialThreadCreate(db, REVIEWER, entry, {
		anchor: { type: "field", field: "excerpt" },
		body: EXCERPT_THREAD_BODY,
	});
}
