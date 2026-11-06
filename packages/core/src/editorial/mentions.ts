import { Permissions } from "@emdash-cms/auth";
import { sql, type Kysely } from "kysely";

import type { Database } from "../database/types.js";
import { chunks, SQL_BATCH_SIZE } from "../utils/chunks.js";

const MENTION_RE = /<@([^<>\s]{1,64})>/g;
const LIKE_ESCAPE_RE = /[%_\\]/g;

export const EDITORIAL_MENTION_LIMIT = 50;
export const EDITORIAL_MENTIONABLE_LIMIT = 10;

export interface EditorialUser {
	id: string;
	name: string | null;
	avatarUrl: string | null;
	email: string;
	emailVerified: boolean;
	/** Holds `editorial:comment` and isn't disabled. */
	canComment: boolean;
}

/** The distinct user IDs a body mentions with `<@USER_ID>`, in order of first mention. */
export function extractMentions(body: string): string[] {
	const ids = new Set<string>();
	for (const match of body.matchAll(MENTION_RE)) ids.add(match[1]);
	return [...ids];
}

/** Replaces each mention token with `@` and the user's name. */
export function renderMentions(body: string, names: Map<string, string>): string {
	return body.replace(MENTION_RE, (_, id: string) => `@${names.get(id) ?? "unknown user"}`);
}

export async function findEditorialUsers(
	db: Kysely<Database>,
	ids: Iterable<string>,
): Promise<Map<string, EditorialUser>> {
	const users = new Map<string, EditorialUser>();
	for (const batch of chunks([...new Set(ids)], SQL_BATCH_SIZE)) {
		const rows = await db
			.selectFrom("users")
			.select(["id", "name", "avatar_url", "email", "email_verified", "role", "disabled"])
			.where("id", "in", batch)
			.execute();
		for (const row of rows) {
			users.set(row.id, {
				id: row.id,
				name: row.name,
				avatarUrl: row.avatar_url,
				email: row.email,
				emailVerified: row.email_verified === 1,
				canComment: !row.disabled && row.role >= Permissions["editorial:comment"],
			});
		}
	}
	return users;
}

/** Users who may be mentioned, matched by display name. Never includes email addresses. */
export async function searchMentionableUsers(
	db: Kysely<Database>,
	query: string,
): Promise<Array<{ id: string; name: string | null; avatarUrl: string | null }>> {
	let select = db
		.selectFrom("users")
		.select(["id", "name", "avatar_url"])
		.where("disabled", "=", 0)
		.where("role", ">=", Permissions["editorial:comment"]);
	const term = query.trim();
	if (term) {
		const pattern = `%${term.replace(LIKE_ESCAPE_RE, (ch) => `\\${ch}`)}%`;
		select = select.where(sql<boolean>`lower(name) LIKE lower(${pattern}) ESCAPE '\\'`);
	}
	const rows = await select
		.orderBy("name", "asc")
		.orderBy("id", "asc")
		.limit(EDITORIAL_MENTIONABLE_LIMIT)
		.execute();
	return rows.map((row) => ({ id: row.id, name: row.name, avatarUrl: row.avatar_url }));
}
