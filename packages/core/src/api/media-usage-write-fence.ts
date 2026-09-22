import type { Kysely } from "kysely";

import { tableExists } from "../database/dialect-helpers.js";
import type { Database } from "../database/types.js";
import { apiError } from "./error.js";

export interface MediaUsageActivationWriteFenceError {
	code: "MEDIA_USAGE_ACTIVATION_IN_PROGRESS" | "MEDIA_USAGE_ACTIVATION_CHECK_FAILED";
	message: string;
	status: 503;
}

export class MediaUsageActivationWriteBlockedError extends Error {
	constructor(
		readonly code: MediaUsageActivationWriteFenceError["code"],
		message: string,
		readonly status: 503,
	) {
		super(message);
		this.name = code;
	}
}

export async function checkMediaUsageActivationWriteFence(
	db: Kysely<Database>,
): Promise<Response | null> {
	const error = await findMediaUsageActivationWriteFenceError(db);
	return error ? apiError(error.code, error.message, error.status) : null;
}

export async function assertMediaUsageActivationWriteAllowed(db: Kysely<Database>): Promise<void> {
	const error = await findMediaUsageActivationWriteFenceError(db);
	if (error) {
		throw new MediaUsageActivationWriteBlockedError(error.code, error.message, error.status);
	}
}

export async function findMediaUsageActivationWriteFenceError(
	db: Kysely<Database>,
): Promise<MediaUsageActivationWriteFenceError | null> {
	if (!(await tableExists(db, "_emdash_media_usage_activation"))) return null;
	try {
		const row = await db
			.selectFrom("_emdash_media_usage_activation")
			.select("state")
			.where("task_key", "=", "incremental_capture")
			.executeTakeFirst();
		if (row?.state === "activating") {
			return {
				code: "MEDIA_USAGE_ACTIVATION_IN_PROGRESS",
				message: "Media usage activation is in progress",
				status: 503,
			};
		}
	} catch (error) {
		console.error("[media-usage] Failed to check the activation write fence:", error);
		return {
			code: "MEDIA_USAGE_ACTIVATION_CHECK_FAILED",
			message: "Unable to verify media usage activation state",
			status: 503,
		};
	}
	return null;
}
