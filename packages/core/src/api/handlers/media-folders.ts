import type { Kysely } from "kysely";

import {
	MediaFolderRepository,
	type MediaFolder,
} from "../../database/repositories/media-folders.js";
import { EmDashValidationError, InvalidCursorError } from "../../database/repositories/types.js";
import type { Database } from "../../database/types.js";
import type { ApiResult } from "../types.js";

const UNIQUE_VIOLATION_RE =
	/unique constraint failed|duplicate key value violates unique constraint/i;

export async function handleMediaFolderList(
	db: Kysely<Database>,
	options: { limit?: number; cursor?: string; q?: string } = {},
): Promise<ApiResult<{ items: MediaFolder[]; nextCursor?: string }>> {
	try {
		const result = await new MediaFolderRepository(db).findMany(options);
		return { success: true, data: result };
	} catch (error) {
		if (error instanceof InvalidCursorError) {
			return { success: false, error: { code: "INVALID_CURSOR", message: error.message } };
		}
		return {
			success: false,
			error: { code: "MEDIA_FOLDER_LIST_ERROR", message: "Failed to list media folders" },
		};
	}
}

export async function handleMediaFolderGet(
	db: Kysely<Database>,
	id: string,
): Promise<ApiResult<{ item: MediaFolder }>> {
	try {
		const item = await new MediaFolderRepository(db).findById(id);
		if (!item) {
			return { success: false, error: { code: "NOT_FOUND", message: "Media folder not found" } };
		}
		return { success: true, data: { item } };
	} catch {
		return {
			success: false,
			error: { code: "MEDIA_FOLDER_GET_ERROR", message: "Failed to get media folder" },
		};
	}
}

export async function handleMediaFolderCreate(
	db: Kysely<Database>,
	input: { name: string },
): Promise<ApiResult<{ item: MediaFolder }>> {
	try {
		const item = await new MediaFolderRepository(db).create(input.name);
		return { success: true, data: { item } };
	} catch (error) {
		return mediaFolderWriteError(
			error,
			"MEDIA_FOLDER_CREATE_ERROR",
			"Failed to create media folder",
		);
	}
}

export async function handleMediaFolderUpdate(
	db: Kysely<Database>,
	id: string,
	input: { name: string },
): Promise<ApiResult<{ item: MediaFolder }>> {
	try {
		const item = await new MediaFolderRepository(db).update(id, input.name);
		if (!item) {
			return { success: false, error: { code: "NOT_FOUND", message: "Media folder not found" } };
		}
		return { success: true, data: { item } };
	} catch (error) {
		return mediaFolderWriteError(
			error,
			"MEDIA_FOLDER_UPDATE_ERROR",
			"Failed to update media folder",
		);
	}
}

export async function handleMediaFolderDelete(
	db: Kysely<Database>,
	id: string,
): Promise<ApiResult<{ deleted: true }>> {
	try {
		const deleted = await new MediaFolderRepository(db).delete(id);
		if (!deleted) {
			return { success: false, error: { code: "NOT_FOUND", message: "Media folder not found" } };
		}
		return { success: true, data: { deleted: true } };
	} catch {
		return {
			success: false,
			error: { code: "MEDIA_FOLDER_DELETE_ERROR", message: "Failed to delete media folder" },
		};
	}
}

function mediaFolderWriteError(
	error: unknown,
	code: "MEDIA_FOLDER_CREATE_ERROR" | "MEDIA_FOLDER_UPDATE_ERROR",
	message: string,
): ApiResult<never> {
	if (error instanceof EmDashValidationError) {
		return { success: false, error: { code: "VALIDATION_ERROR", message: error.message } };
	}
	if (isUniqueViolation(error)) {
		return {
			success: false,
			error: { code: "CONFLICT", message: "A media folder with this name already exists" },
		};
	}
	return { success: false, error: { code, message } };
}

function isUniqueViolation(error: unknown): boolean {
	if (error && typeof error === "object") {
		if ("code" in error && error.code === "23505") return true;
	}
	const message = error instanceof Error ? error.message : "";
	if (UNIQUE_VIOLATION_RE.test(message)) return true;
	return Boolean(
		error && typeof error === "object" && "cause" in error && isUniqueViolation(error.cause),
	);
}
