/**
 * A process's room registry over SQLite and the fake site, for host tests that need a process of
 * their own. Bundled before the suite runs, so it can't import Vitest.
 */

import { Kysely, SqliteDialect } from "kysely";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database } from "../../../src/database/types.js";
import { openNodeSqliteDatabase } from "../../../src/db/node-sqlite-compat.js";
import { RoomRegistry } from "../../../src/rooms/node/registry.js";
import { roomId, type Build, type RoomTimers, type TokenClaims } from "../../../src/rooms/types.js";
import { FakeSite } from "../../unit/rooms/fake-site.js";

export const BUILD: Build = { version: "1.0.0", commit: "abc123" };
export const ROOM = roomId({ collection: "posts", id: "01ENTRY" });

export async function openDatabase(path: string): Promise<Kysely<Database>> {
	const db = new Kysely<Database>({
		dialect: new SqliteDialect({ database: openNodeSqliteDatabase(path) }),
	});
	await runMigrations(db);
	return db;
}

export function startRegistry(
	db: Kysely<Database>,
	timers?: RoomTimers,
): { registry: RoomRegistry; site: FakeSite } {
	const site = new FakeSite({
		fields: [{ slug: "title", type: "string" }],
		data: { title: "Hello" },
	});
	const registry = new RoomRegistry({ db, site, build: BUILD, timers });
	registry.activate();
	return { registry, site };
}

export function claims(site: FakeSite, userId: string): TokenClaims {
	const entry = site.current;
	return {
		userId,
		name: userId,
		access: "edit",
		fingerprint: { ...BUILD, hash: entry.hash },
		rev: entry.rev,
		status: entry.status,
		authorId: entry.authorId,
	};
}

/** The issued token, or what the registry answered instead. */
export async function issue(
	registry: RoomRegistry,
	site: FakeSite,
	userId: string,
): Promise<string | null> {
	const issued = await registry.issueToken(ROOM, claims(site, userId));
	return typeof issued === "object" && issued !== null ? "token" : issued;
}
