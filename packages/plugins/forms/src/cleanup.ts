import type { PluginContext } from "emdash";

import type { SubmissionFile } from "./types.js";

export async function deleteSubmissionFiles(
	ctx: PluginContext,
	files: SubmissionFile[] | undefined,
): Promise<boolean> {
	if (!files?.length) return true;
	if (!ctx.media?.delete) {
		ctx.log.error("Cannot delete submission attachments: media storage is unavailable");
		return false;
	}

	let deleted = true;
	for (const file of files) {
		try {
			await ctx.media.delete(file.mediaId);
		} catch (error) {
			deleted = false;
			ctx.log.error("Failed to delete submission attachment", {
				mediaId: file.mediaId,
				error: String(error),
			});
		}
	}
	return deleted;
}
