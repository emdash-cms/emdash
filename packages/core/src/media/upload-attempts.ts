import { ulid } from "ulidx";

import type { MediaRepository } from "../database/repositories/media.js";
import type { Storage } from "../storage/types.js";

/** A fresh key beside `key`, with its extension, that no client has been handed. */
export function createUploadAttemptKey(key: string): string {
	const pathSeparator = key.lastIndexOf("/");
	const extensionSeparator = key.lastIndexOf(".");
	if (extensionSeparator > pathSeparator) {
		return `${key.slice(0, extensionSeparator)}.${ulid()}${key.slice(extensionSeparator)}`;
	}
	return `${key}.${ulid()}`;
}

export async function removeUploadAttempt(
	storage: Storage,
	repo: MediaRepository,
	storageKey: string,
	options: { allowUntracked?: boolean } = {},
): Promise<boolean> {
	try {
		if (!(await repo.claimUploadAttemptForCleanup(storageKey))) {
			const tracked = await repo.hasUploadAttempt(storageKey);
			if (tracked || !options.allowUntracked) return false;
		}
	} catch (error) {
		console.error("[media] upload cleanup claim failed:", error);
		return false;
	}

	try {
		await storage.delete(storageKey);
	} catch (error) {
		console.error("[media] upload cleanup failed:", error);
		try {
			await repo.deferUploadAttemptCleanup(storageKey);
		} catch (deferError) {
			console.error("[media] upload cleanup deferral failed:", deferError);
		}
		return false;
	}

	try {
		await repo.deleteUploadAttempt(storageKey);
	} catch (error) {
		console.error("[media] upload cleanup record deletion failed:", error);
	}
	return true;
}

/**
 * Copy an object that arrived through a signed upload URL to a fresh upload
 * attempt key and return that key.
 *
 * A signed upload URL keeps accepting uploads to its key until it expires, so
 * a ready item must not keep that key or its file could still change. Callers
 * verify the copy, publish it with `publishPendingStorageKey` and then call
 * `retireSignedUploadKey`. A copy that is never published is
 * removed by the upload attempt cleanup.
 */
export async function copySignedUpload(
	storage: Storage,
	repo: MediaRepository,
	media: { id: string; storageKey: string; mimeType: string },
): Promise<string> {
	const attemptKey = createUploadAttemptKey(media.storageKey);
	await repo.createUploadAttempt(media.id, attemptKey);
	try {
		if (storage.copy) {
			await storage.copy({
				sourceKey: media.storageKey,
				key: attemptKey,
				contentType: media.mimeType,
			});
		} else {
			const source = await storage.download(media.storageKey);
			await storage.upload({ key: attemptKey, body: source.body, contentType: media.mimeType });
		}
	} catch (error) {
		await removeUploadAttempt(storage, repo, attemptKey);
		throw error;
	}
	return attemptKey;
}

/**
 * Delete the object under a signed upload URL's key once its copy is published.
 *
 * The URL can still write the key until it expires, so the key stays on record
 * as an upload attempt: the cleanup sweep deletes whatever is stored under it
 * once the attempt is older than the cleanup age, which is derived from
 * `SIGNED_UPLOAD_URL_EXPIRES_IN_SECONDS`.
 */
export async function retireSignedUploadKey(
	storage: Storage,
	repo: MediaRepository,
	mediaId: string,
	storageKey: string,
): Promise<void> {
	try {
		await repo.createUploadAttempt(mediaId, storageKey);
	} catch (error) {
		console.error("[media] signed upload key tracking failed:", error);
	}
	try {
		// A legacy duplicate registration may still point another row at the object.
		if (!(await repo.isStorageKeyReferenced(storageKey))) await storage.delete(storageKey);
	} catch (error) {
		console.error("[media] signed upload key cleanup failed:", error);
	}
}
