import { sql, type Kysely } from "kysely";
import { ulid } from "ulidx";

import type { Database } from "../types.js";
import { decodeCursor, EmDashValidationError, encodeCursor, type FindManyResult } from "./types.js";

export interface MediaFolder {
	id: string;
	name: string;
}

export interface FindManyMediaFoldersOptions {
	limit?: number;
	cursor?: string;
	q?: string;
}

function escapeLike(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function normalizeFolderSearch(value: string): string {
	return value.trim().normalize("NFKC").toLowerCase();
}

function normalizeFolderName(name: string): { name: string; nameKey: string } {
	if (typeof name !== "string") {
		throw new EmDashValidationError("Folder name must be a string");
	}
	const trimmed = name.trim();
	if (trimmed.length < 1 || trimmed.length > 200) {
		throw new EmDashValidationError("Folder name must be between 1 and 200 characters");
	}
	return { name: trimmed, nameKey: trimmed.normalize("NFKC").toLowerCase() };
}

export class MediaFolderRepository {
	constructor(private db: Kysely<Database>) {}

	async findMany(options: FindManyMediaFoldersOptions = {}): Promise<FindManyResult<MediaFolder>> {
		const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
		let query = this.db
			.selectFrom("media_folders")
			.select(["id", "name", "name_key"])
			.orderBy("name_key", "asc")
			.orderBy("id", "asc")
			.limit(limit + 1);

		const term = normalizeFolderSearch(options.q ?? "");
		if (term) {
			const pattern = `%${escapeLike(term)}%`;
			query = query.where("name_key", "like", sql<string>`${pattern} escape '\\'`);
		}

		if (options.cursor !== undefined) {
			const { orderValue: nameKey, id } = decodeCursor(options.cursor);
			query = query.where((eb) =>
				eb.or([
					eb("name_key", ">", nameKey),
					eb.and([eb("name_key", "=", nameKey), eb("id", ">", id)]),
				]),
			);
		}

		const rows = await query.execute();
		const hasMore = rows.length > limit;
		const visible = rows.slice(0, limit);
		return {
			items: visible.map(({ id, name }) => ({ id, name })),
			nextCursor:
				hasMore && visible.length > 0
					? encodeCursor(visible.at(-1)!.name_key, visible.at(-1)!.id)
					: undefined,
		};
	}

	async findById(id: string): Promise<MediaFolder | null> {
		const row = await this.db
			.selectFrom("media_folders")
			.select(["id", "name"])
			.where("id", "=", id)
			.executeTakeFirst();
		return row ?? null;
	}

	async create(inputName: string): Promise<MediaFolder> {
		const { name, nameKey } = normalizeFolderName(inputName);
		const row = await this.db
			.insertInto("media_folders")
			.values({ id: ulid(), name, name_key: nameKey })
			.returning(["id", "name"])
			.executeTakeFirstOrThrow();
		return row;
	}

	async update(id: string, inputName: string): Promise<MediaFolder | null> {
		const { name, nameKey } = normalizeFolderName(inputName);
		const row = await this.db
			.updateTable("media_folders")
			.set({ name, name_key: nameKey })
			.where("id", "=", id)
			.returning(["id", "name"])
			.executeTakeFirst();
		return row ?? null;
	}

	async delete(id: string): Promise<boolean> {
		const row = await this.db
			.deleteFrom("media_folders")
			.where("id", "=", id)
			.returning("id")
			.executeTakeFirst();
		return row !== undefined;
	}
}
