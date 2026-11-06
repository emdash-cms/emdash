/**
 * Media for an export: which rows are exported, their blob digests, and the
 * storage-key index the reference walker needs.
 *
 * A media row is exported when it is `ready`, or when a byline avatar or a
 * section preview references it and its object exists. Its object is hashed
 * once from the origin key; the bytes are never copied into staging.
 */

import { sql, type Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import type { Storage } from "../../storage/types.js";
import { createSha256 } from "../format/digest.js";
import {
	buildMediaKeyIndex,
	MEDIA_PLACEHOLDER_PREFIX,
	type MediaKeyIndex,
} from "../format/media-refs.js";
import { bytewise } from "../ops/collation.js";

type Db = Kysely<Database>;

const KEY_INDEX_PAGE = 1000;

export interface MediaCandidate {
	id: string;
	storageKey: string;
	status: string;
	size: number | null;
}

/** Media rows eligible for export after `after`, in id order. */
export async function listMediaCandidates(
	db: Db,
	after: string | null,
	limit: number,
): Promise<MediaCandidate[]> {
	let query = db
		.selectFrom("media")
		.select(["id", "storage_key", "status", "size"])
		.where((eb) =>
			eb.or([
				eb("status", "=", "ready"),
				eb(
					"id",
					"in",
					eb
						.selectFrom("_emdash_bylines")
						.select("avatar_media_id")
						.where("avatar_media_id", "is not", null)
						.$castTo<string>(),
				),
				eb(
					"id",
					"in",
					eb
						.selectFrom("_emdash_sections")
						.select("preview_media_id")
						.where("preview_media_id", "is not", null)
						.$castTo<string>(),
				),
			]),
		);
	if (after !== null) query = query.where(sql<boolean>`${bytewise(db, "id")} > ${after}`);
	const rows = await query.orderBy(bytewise(db, "id")).limit(limit).execute();
	return rows.map((row) => ({
		id: row.id,
		storageKey: row.storage_key,
		status: row.status,
		size: row.size === null ? null : Number(row.size),
	}));
}

/**
 * SHA-256 and size of a stored object, counted from the bytes actually
 * streamed. Returns null when the object does not exist, and `"too_large"`
 * (after cancelling the download) as soon as more than `maxBytes` arrive.
 */
export async function hashStoredObject(
	storage: Storage,
	key: string,
	options: { maxBytes?: number } = {},
): Promise<{ sha256: string; bytes: number } | null | "too_large"> {
	if (!(await storage.exists(key))) return null;
	const download = await storage.download(key);
	const hasher = await createSha256();
	const reader = download.body.getReader();
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (options.maxBytes !== undefined && bytes > options.maxBytes) {
				await reader.cancel().catch(() => undefined);
				return "too_large";
			}
			hasher.update(value);
		}
	} finally {
		reader.releaseLock();
	}
	return { sha256: await hasher.digest(), bytes };
}

/** Every media row's id and storage key, in id order. */
export async function loadMediaKeyRows(db: Db): Promise<Array<{ id: string; storageKey: string }>> {
	const rows: Array<{ id: string; storageKey: string }> = [];
	let after: string | null = null;
	for (;;) {
		let query = db.selectFrom("media").select(["id", "storage_key"]);
		if (after !== null) query = query.where(sql<boolean>`${bytewise(db, "id")} > ${after}`);
		const page = await query.orderBy(bytewise(db, "id")).limit(KEY_INDEX_PAGE).execute();
		for (const row of page) rows.push({ id: row.id, storageKey: row.storage_key });
		const last = page.at(-1);
		if (page.length < KEY_INDEX_PAGE || !last) break;
		after = last.id;
	}
	return rows;
}

/** Every media row's storage key, for the reference walker and the key scan. */
export async function loadMediaKeyIndex(db: Db): Promise<MediaKeyIndex> {
	return buildMediaKeyIndex(await loadMediaKeyRows(db));
}

const PLACEHOLDER = new RegExp(`${MEDIA_PLACEHOLDER_PREFIX}([0-9A-Za-z_-]{1,128})`, "g");

function unlinkValue(
	value: unknown,
	drop: ReadonlySet<string>,
	counter: { count: number },
): unknown {
	if (typeof value === "string") {
		if (!value.includes(MEDIA_PLACEHOLDER_PREFIX)) return value;
		return value.replace(PLACEHOLDER, (match, mediaId: string) => {
			if (!drop.has(mediaId)) return match;
			counter.count++;
			return "";
		});
	}
	if (Array.isArray(value)) return value.map((item) => unlinkValue(item, drop, counter));
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, unlinkValue(item, drop, counter)]),
		);
	}
	return value;
}

/**
 * Remove placeholders naming media that is not in the package, leaving the
 * rest of each string. Returns the record unchanged when there are none.
 */
export function unlinkMediaPlaceholders<T extends { kind: string; id: string }>(
	record: T,
	drop: ReadonlySet<string>,
): { record: T; count: number } {
	if (drop.size === 0) return { record, count: 0 };
	const counter = { count: 0 };
	const next = unlinkValue(record, drop, counter);
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- same record with some placeholder substrings removed
	return counter.count === 0 ? { record, count: 0 } : { record: next as T, count: counter.count };
}
