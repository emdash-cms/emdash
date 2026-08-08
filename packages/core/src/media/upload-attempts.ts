import type { MediaRepository } from "../database/repositories/media.js";
import type { Storage } from "../storage/types.js";

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
		return false;
	}

	try {
		await repo.deleteUploadAttempt(storageKey);
	} catch (error) {
		console.error("[media] upload cleanup record deletion failed:", error);
	}
	return true;
}
