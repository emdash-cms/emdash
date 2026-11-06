/**
 * Reading staged record chunks for analysis, turning every failure into a
 * blocker whose message and detail never include package content: only the
 * error code of a read failure is used, with a fixed message.
 */

import { TransferError, type TransferErrorCode } from "../errors.js";
import { parseCanonicalJson } from "../format/canonical.js";
import { sha256Hex } from "../format/digest.js";
import { validateRecord, type RecordKind, type RecordOfKind } from "../format/kinds.js";
import { TRANSFER_LIMITS } from "../format/limits.js";
import type { PlanBlocker, PlanBlockerCode } from "../format/plan.js";
import { splitChunkLines } from "../format/records.js";
import { readStreamBytes, type ExpectedFile, type TransferStage } from "../staging/stage.js";

const encoder = new TextEncoder();

const ERROR_BLOCKERS: Partial<
	Record<TransferErrorCode, { code: PlanBlockerCode; message: string }>
> = {
	TRANSFER_LIMIT_EXCEEDED: { code: "limit_exceeded", message: "Package file exceeds a limit" },
	TRANSFER_FILE_MISSING: { code: "file_missing", message: "Package file is missing" },
	TRANSFER_FILE_SIZE_MISMATCH: {
		code: "file_mismatch",
		message: "Package file size does not match its declaration",
	},
	TRANSFER_FILE_DIGEST_MISMATCH: {
		code: "file_mismatch",
		message: "Package file digest does not match its declaration",
	},
	TRANSFER_UNSUPPORTED_FORMAT: {
		code: "unsupported_format",
		message: "Unsupported package format or version",
	},
	TRANSFER_UNSUPPORTED_FEATURE: {
		code: "unsupported_feature",
		message: "Package requires features this site does not support",
	},
	TRANSFER_RECORD_INVALID: { code: "record_invalid", message: "Package file is malformed" },
	TRANSFER_PATH_INVALID: { code: "package_invalid", message: "Package path is invalid" },
};

/**
 * A blocker for a {@link TransferError} raised while reading package files.
 * Only the error code is used; the location comes from the caller.
 */
export function blockerForError(
	error: TransferError,
	location: { path?: string; line?: number } = {},
): PlanBlocker {
	const mapped = ERROR_BLOCKERS[error.code] ?? {
		code: "package_invalid",
		message: "Package file failed validation",
	};
	const detail: Record<string, string | number> = {};
	if (location.path !== undefined) detail.path = location.path;
	if (location.line !== undefined) detail.line = location.line;
	return { code: mapped.code, message: mapped.message, detail };
}

/** Read one staged chunk, verifying size and digest, and split it into lines. */
export async function readVerifiedChunk(
	stage: TransferStage,
	path: string,
	expected: ExpectedFile,
): Promise<string[]> {
	const file = await stage.open(path);
	let bytes: Uint8Array;
	try {
		bytes = await readStreamBytes(file.body, expected.bytes);
	} catch (error) {
		if (error instanceof TransferError && error.code === "TRANSFER_LIMIT_EXCEEDED") {
			throw new TransferError("TRANSFER_FILE_SIZE_MISMATCH", "Staged file size does not match");
		}
		throw error;
	}
	if (bytes.byteLength !== expected.bytes) {
		throw new TransferError("TRANSFER_FILE_SIZE_MISMATCH", "Staged file size does not match");
	}
	if ((await sha256Hex(bytes)) !== expected.sha256) {
		throw new TransferError("TRANSFER_FILE_DIGEST_MISMATCH", "Staged file digest does not match");
	}
	return splitChunkLines(bytes, path);
}

export type DecodedLine<K extends RecordKind> =
	| { ok: true; record: RecordOfKind<K> }
	| { ok: false; blocker: PlanBlocker };

/**
 * Decode and strictly validate one record line. A failure names the chunk,
 * the one-based line, and at most a known top-level property of the kind.
 */
export function decodeRecordLine<K extends RecordKind>(
	kind: K,
	line: string,
	location: { path: string; line: number },
): DecodedLine<K> {
	const detail = { path: location.path, line: location.line };
	if (encoder.encode(line).byteLength > TRANSFER_LIMITS.recordLineBytes) {
		return {
			ok: false,
			blocker: {
				code: "limit_exceeded",
				message: "Record exceeds the line size limit",
				kind,
				detail,
			},
		};
	}
	let raw: unknown;
	try {
		raw = parseCanonicalJson(line);
	} catch {
		return {
			ok: false,
			blocker: { code: "record_invalid", message: "Record is not canonical JSON", kind, detail },
		};
	}
	const result = validateRecord(kind, raw);
	if (!result.success) {
		const field = result.issues[0]?.path || undefined;
		return {
			ok: false,
			blocker: {
				code: "record_invalid",
				message: "Record failed schema validation",
				kind,
				detail: field === undefined ? detail : { ...detail, field },
			},
		};
	}
	return { ok: true, record: result.record };
}
