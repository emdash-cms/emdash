import type { Kysely } from "kysely";

import { columnExists } from "../dialect-helpers.js";

const DUPLICATE_COLUMN_RE = /(?:duplicate column|column .* already exists|already exists.*column)/i;

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("media_folders")
		.ifNotExists()
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("name", "text", (col) => col.notNull())
		.addColumn("name_key", "text", (col) => col.notNull().unique())
		.execute();

	await addFolderColumnIfMissing(db, () =>
		db.schema
			.alterTable("media")
			.addColumn("folder_id", "text", (col) =>
				col.references("media_folders.id").onDelete("set null"),
			)
			.execute(),
	);

	await db.schema
		.createIndex("idx_media_folder_id")
		.ifNotExists()
		.on("media")
		.column("folder_id")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("idx_media_folder_id").ifExists().execute();
	if (await columnExists(db, "media", "folder_id")) {
		await db.schema.alterTable("media").dropColumn("folder_id").execute();
	}
	await db.schema.dropTable("media_folders").ifExists().execute();
}

async function addFolderColumnIfMissing(
	db: Kysely<unknown>,
	addColumn: () => Promise<void>,
): Promise<void> {
	if (await columnExists(db, "media", "folder_id")) return;

	try {
		await addColumn();
	} catch (error) {
		if (DUPLICATE_COLUMN_RE.test(deepErrorMessage(error))) {
			if (await columnExists(db, "media", "folder_id")) return;
		}
		throw error;
	}
}

function deepErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		const own = error.message ?? "";
		if (error.cause) {
			const causeMessage = deepErrorMessage(error.cause);
			return own ? `${own}: ${causeMessage}` : causeMessage;
		}
		return own;
	}
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}
