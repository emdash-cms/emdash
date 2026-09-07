import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import {
	activateMediaUsageCapture,
	getMediaUsageActivationStatus,
	MediaUsageActivationVersionMismatchError,
} from "../../media/usage/activation.js";
import { ErrorCode } from "../errors.js";
import type {
	MediaUsageActivationAdvanceRequest,
	MediaUsageActivationAdvanceResponse,
	MediaUsageActivationStatus,
} from "../schemas/media-usage.js";
import type { ApiResult } from "../types.js";

export async function handleMediaUsageActivationStatus(
	db: Kysely<Database>,
): Promise<ApiResult<MediaUsageActivationStatus>> {
	try {
		return { success: true, data: await getMediaUsageActivationStatus(db) };
	} catch (error) {
		if (error instanceof MediaUsageActivationVersionMismatchError) {
			return {
				success: false,
				error: {
					code: ErrorCode.MEDIA_USAGE_ACTIVATION_VERSION_MISMATCH,
					message: "Media usage activation version is incompatible with this runtime",
				},
			};
		}
		console.error("[media-usage:activation] status read failed:", error);
		return {
			success: false,
			error: {
				code: ErrorCode.MEDIA_USAGE_ACTIVATION_READ_ERROR,
				message: "Failed to read media usage activation status",
			},
		};
	}
}

export async function handleMediaUsageActivationAdvance(
	db: Kysely<Database>,
	input: MediaUsageActivationAdvanceRequest,
): Promise<ApiResult<MediaUsageActivationAdvanceResponse>> {
	try {
		const result = await activateMediaUsageCapture(db, {
			writersDrained: input.writersDrained,
		});
		if (result.outcome === "lease_active") {
			return {
				success: false,
				error: {
					code: ErrorCode.MEDIA_USAGE_ACTIVATION_BUSY,
					message: "Media usage activation is already in progress",
					details: { leaseExpiresAt: result.leaseExpiresAt },
				},
			};
		}
		if (result.outcome === "conflict") {
			return {
				success: false,
				error: {
					code: ErrorCode.MEDIA_USAGE_ACTIVATION_CONFLICT,
					message: "Media usage activation ownership changed",
				},
			};
		}

		const activation = await getMediaUsageActivationStatus(db);
		if (activation.state === "expanded") {
			throw new Error("Media usage activation did not advance");
		}
		return {
			success: true,
			data: {
				outcome: activation.state,
				processedCollections: result.processedCollections,
				activation,
			},
		};
	} catch (error) {
		if (error instanceof MediaUsageActivationVersionMismatchError) {
			return {
				success: false,
				error: {
					code: ErrorCode.MEDIA_USAGE_ACTIVATION_VERSION_MISMATCH,
					message: "Media usage activation version is incompatible with this runtime",
				},
			};
		}
		console.error("[media-usage:activation] advance failed:", error);
		return {
			success: false,
			error: {
				code: ErrorCode.MEDIA_USAGE_ACTIVATION_ADVANCE_ERROR,
				message: "Failed to advance media usage activation",
			},
		};
	}
}
