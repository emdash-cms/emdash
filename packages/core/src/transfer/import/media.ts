/**
 * Media writer: one target object per media row.
 *
 * Each media row's bytes are copied from its staged blob to a deterministic
 * target key, `${ulidFromHash(operationId, mediaId)}${ext}`, so an
 * interrupted copy is simply repeated. An upload attempt is registered before
 * the copy so media cleanup reclaims the object if the import is abandoned
 * before the row exists. The copy is verified against the blob's declared
 * size and SHA-256, and the row's `content_hash` is recomputed from the bytes
 * exactly as uploads do (SHA-1, only up to `MAX_CONTENT_HASH_BYTES`).
 */

import mime from "mime/lite";

import { MediaRepository } from "../../database/repositories/media.js";
import { computeContentHash, MAX_CONTENT_HASH_BYTES } from "../../utils/hash.js";
import { TransferError } from "../errors.js";
import type { MediaRecord } from "../format/kinds.js";
import { mediaBlobPath } from "../format/paths.js";
import { MEDIA_STORAGE_KEY_ENTITY } from "../ops/identity-map.js";
import { TransferStagedFileRepository } from "../ops/staged-files.js";
import { putVerified } from "../staging/stage.js";
import type { ImportContext } from "./context.js";
import { ulidFromHash } from "./ids.js";
import { writeRecords, type WriteInput } from "./writers.js";

const EXTENSION = /\.[A-Za-z0-9]{1,16}$/;
const MIME_EXTENSION = /^[a-z0-9]{1,16}$/;

export function mediaExtension(record: Pick<MediaRecord, "filename" | "mimeType">): string {
	const fromName = EXTENSION.exec(record.filename)?.[0];
	if (fromName) return fromName.toLowerCase();
	const fromType = mime.getExtension(record.mimeType);
	return fromType && MIME_EXTENSION.test(fromType) ? `.${fromType}` : "";
}

export async function mediaStorageKey(
	context: ImportContext,
	record: MediaRecord,
): Promise<string> {
	return `${await ulidFromHash(context.operationId, "media", record.id)}${mediaExtension(record)}`;
}

/** Declared size of a media row's staged blob. */
export async function blobBytes(context: ImportContext, record: MediaRecord): Promise<number> {
	const staged = await new TransferStagedFileRepository(context.db).get(
		context.operationId,
		mediaBlobPath(record.blob),
	);
	if (!staged || staged.state !== "verified") {
		throw new TransferError("TRANSFER_MEDIA_BLOB_MISSING", "Media blob is not staged", {
			detail: { kind: "media", id: record.id },
		});
	}
	return staged.bytes;
}

/** Statements `writeMedia` needs for one row. */
export const MEDIA_ROW_STATEMENTS = 12;

export async function writeMedia(
	context: ImportContext,
	input: WriteInput<"media">,
	bytes: number,
): Promise<void> {
	const record = input.record;
	const storageKey = await mediaStorageKey(context, record);
	await context.identity.put(MEDIA_STORAGE_KEY_ENTITY, {
		portableId: record.id,
		targetId: storageKey,
	});

	const rewritten = await context.rewrittenIds("media", [record]);
	const targetId = rewritten.get(`media\u0000${record.id}`) ?? record.id;
	const existing = await context.db
		.selectFrom("media")
		.select(["storage_key", "status"])
		.where("id", "=", targetId)
		.executeTakeFirst();

	let contentHash: string | null = null;
	const ours = existing?.storage_key === storageKey;
	if (ours) {
		const stored = await context.db
			.selectFrom("media")
			.select("content_hash")
			.where("id", "=", targetId)
			.executeTakeFirstOrThrow();
		contentHash = stored.content_hash;
	} else {
		const media = new MediaRepository(context.db);
		if (!(await media.hasUploadAttempt(storageKey))) {
			await media.createUploadAttempt(targetId, storageKey);
		}
		contentHash = await copyBlob(context, record, storageKey, bytes);
	}

	await writeRecords(context, "media", [input], {
		extra: () => ({
			row: { storage_key: storageKey, content_hash: contentHash, status: "ready" },
			codecs: { storage_key: "text", status: "text" },
		}),
	});
	if (!ours) await new MediaRepository(context.db).deleteUploadAttempt(storageKey);
}

async function copyBlob(
	context: ImportContext,
	record: MediaRecord,
	storageKey: string,
	bytes: number,
): Promise<string | null> {
	const retained: Uint8Array[] = [];
	let retainedBytes = 0;
	const keepForHash = bytes > 0 && bytes <= MAX_CONTENT_HASH_BYTES;
	const tap = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			if (keepForHash && retainedBytes + chunk.byteLength <= MAX_CONTENT_HASH_BYTES) {
				retained.push(chunk.slice());
				retainedBytes += chunk.byteLength;
			}
			controller.enqueue(chunk);
		},
	});
	const body = (await context.reader.blob(record.blob)).pipeThrough(tap);
	await putVerified(
		context.storage,
		storageKey,
		body,
		{ bytes, sha256: record.blob },
		{ contentType: record.mimeType },
	);
	if (!keepForHash || retainedBytes !== bytes) return null;
	const all = new Uint8Array(retainedBytes);
	let offset = 0;
	for (const part of retained) {
		all.set(part, offset);
		offset += part.byteLength;
	}
	return computeContentHash(all);
}
