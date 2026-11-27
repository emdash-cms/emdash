import { sql, type Kysely } from "kysely";

import { editorialMinRole } from "../api/authorize.js";
import type { Database } from "../database/types.js";
import { chunks, SQL_BATCH_SIZE } from "../utils/chunks.js";

const MENTION_RE = /<@([^<>\s]{1,64})>/g;
const LIKE_ESCAPE_RE = /[%_\\]/g;
// oxlint-disable-next-line no-control-regex -- matches any character outside ASCII
const NON_ASCII_RE = /[^\x00-\x7f]/;
const MENTIONABLE_SCAN_BATCH = 200;

export const EDITORIAL_MENTION_LIMIT = 50;
export const EDITORIAL_MENTIONABLE_LIMIT = 10;

export interface EditorialUser {
	id: string;
	name: string | null;
	avatarUrl: string | null;
	email: string;
	emailVerified: boolean;
	/** May take part in editorial threads and isn't disabled. */
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
				canComment: !row.disabled && row.role >= editorialMinRole(),
			});
		}
	}
	return users;
}

interface MentionablePerson {
	id: string;
	name: string | null;
	avatarUrl: string | null;
}

function toPerson(row: { id: string; name: string | null; avatar_url: string | null }) {
	return { id: row.id, name: row.name, avatarUrl: row.avatar_url };
}

/** Users who may be mentioned, matched by display name. Never includes email addresses. */
export async function searchMentionableUsers(
	db: Kysely<Database>,
	query: string,
): Promise<MentionablePerson[]> {
	// Unnamed users, including blank names, can't match a typed name, and sort last on every dialect.
	const displayName = sql`nullif(trim(name), '')`;
	const mentionable = () =>
		db
			.selectFrom("users")
			.select(["id", "name", "avatar_url"])
			.where("disabled", "=", 0)
			.where("role", ">=", editorialMinRole())
			.orderBy(sql`${displayName} IS NULL`)
			.orderBy(displayName)
			.orderBy("id", "asc");
	const term = query.trim();
	if (!NON_ASCII_RE.test(term)) {
		let select = mentionable();
		if (term) {
			const pattern = `%${term.replace(LIKE_ESCAPE_RE, (ch) => `\\${ch}`)}%`;
			select = select.where(sql<boolean>`lower(name) LIKE lower(${pattern}) ESCAPE '\\'`);
		}
		return (await select.limit(EDITORIAL_MENTIONABLE_LIMIT).execute()).map(toPerson);
	}

	// SQLite's lower() and LIKE fold only ASCII letters, so other names are matched here.
	const needle = term.toLowerCase();
	const found: MentionablePerson[] = [];
	for (
		let offset = 0;
		found.length < EDITORIAL_MENTIONABLE_LIMIT;
		offset += MENTIONABLE_SCAN_BATCH
	) {
		// oxlint-disable-next-line no-await-in-loop -- each batch is read only if the earlier ones didn't fill the list
		const rows = await mentionable()
			.where(sql<boolean>`${displayName} IS NOT NULL`)
			.limit(MENTIONABLE_SCAN_BATCH)
			.offset(offset)
			.execute();
		for (const row of rows) {
			if (found.length < EDITORIAL_MENTIONABLE_LIMIT && row.name?.toLowerCase().includes(needle)) {
				found.push(toPerson(row));
			}
		}
		if (rows.length < MENTIONABLE_SCAN_BATCH) break;
	}
	return found;
}
