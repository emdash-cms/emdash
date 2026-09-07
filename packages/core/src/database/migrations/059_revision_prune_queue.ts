import { sql, type Kysely } from "kysely";

const REVISION_KEEP_COUNT = 50;

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_revision_prune_queue")
		.ifNotExists()
		.addColumn("collection", "text", (column) => column.notNull())
		.addColumn("entry_id", "text", (column) => column.notNull())
		.addColumn("revision_id", "text", (column) => column.notNull())
		.addPrimaryKeyConstraint("revision_prune_queue_pk", ["collection", "entry_id"])
		.execute();

	await db.schema
		.createIndex("idx_revision_prune_queue_revision_id")
		.ifNotExists()
		.on("_emdash_revision_prune_queue")
		.column("revision_id")
		.execute();

	await sql`
		INSERT INTO _emdash_revision_prune_queue (collection, entry_id, revision_id)
		SELECT collection, entry_id, MAX(id)
		FROM revisions
		WHERE true
		GROUP BY collection, entry_id
		HAVING COUNT(*) > ${REVISION_KEEP_COUNT}
		ON CONFLICT (collection, entry_id)
		DO UPDATE SET revision_id = excluded.revision_id
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("_emdash_revision_prune_queue").ifExists().execute();
}
