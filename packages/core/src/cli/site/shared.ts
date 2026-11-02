/**
 * Shared pieces of `emdash site`: errors, their user-facing messages,
 * retries, and progress reporting.
 */

import { EmDashApiError } from "../../client/index.js";
import { isTransferError } from "../../transfer/errors.js";
import type {
	ExportTransformationCode,
	ImportTransformationCode,
} from "../../transfer/format/transformations.js";

/** A failure the CLI reports with a stable code, like an API error. */
export class SiteTransferCliError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "SiteTransferCliError";
	}
}

export interface CliErrorInfo {
	code: string;
	message: string;
}

const TRANSFER_MESSAGES: Readonly<Record<string, string>> = {
	TRANSFER_TARGET_NOT_EMPTY:
		"This site already has content. A site package can only be imported into an empty site.",
	TRANSFER_IMPORT_IN_PROGRESS:
		"Another import is in progress on this site, or an unfinished import is still blocking writes. Check it with `emdash site import status <operation-id>`.",
	TRANSFER_EXPORT_CONCURRENT_WRITES:
		"The site kept changing while it was being exported. Run the export again when the site is quiet.",
	TRANSFER_OPERATION_NOT_FOUND: "No transfer operation with that id exists on this site.",
	TRANSFER_EXPIRED:
		"This transfer has expired and its files were removed. Start a new export or import.",
	TRANSFER_IDEMPOTENCY_CONFLICT:
		"This site already has an import started from a different package with the same key.",
	TRANSFER_MANIFEST_INVALID: "The package manifest is invalid.",
	TRANSFER_UNSUPPORTED_FORMAT:
		"This package uses a format version this site does not support. Upgrade EmDash on this site.",
	TRANSFER_UNSUPPORTED_FEATURE:
		"This package needs features this site does not support. Upgrade EmDash on this site.",
	TRANSFER_CONTAINER_INVALID: "The file is not a valid .emdash site package.",
	TRANSFER_FILE_DIGEST_MISMATCH:
		"A package file does not match its recorded digest. The package is damaged or was modified.",
	TRANSFER_FILE_SIZE_MISMATCH:
		"A package file does not have its recorded size. The package is damaged or was modified.",
	TRANSFER_FILE_MISSING: "The package is missing files its manifest lists.",
	TRANSFER_FILE_NOT_DECLARED: "The package contains a file its manifest does not list.",
	TRANSFER_LIMIT_EXCEEDED: "The package exceeds a limit this site enforces.",
	TRANSFER_PACKAGE_DIGEST_MISMATCH:
		"This is not the package that was analyzed. Analyze this package with `--analyze` first.",
	TRANSFER_PLAN_DIGEST_MISMATCH:
		"The plan changed since it was reviewed. Run `emdash site import <file> --analyze` again and confirm the new plan digest.",
	TRANSFER_PLAN_BLOCKED:
		"The import plan has blockers. Run `emdash site import <file> --analyze` to see them.",
	TRANSFER_DECISIONS_INVALID: "The import decisions are invalid.",
	TRANSFER_VERIFICATION_FAILED:
		"The imported site did not verify against the package, so no receipt was issued. Do not use this site; import into a fresh one.",
};

const TRANSFORMATION_LABELS: Readonly<
	Record<ExportTransformationCode | ImportTransformationCode, string>
> = {
	soft_orphan_dropped: "Unused references were left out",
	avatar_nulled: "Some byline avatars were left out",
	redirect_duplicate_dropped: "Duplicate redirects were left out",
	media_not_ready_dropped: "Unfinished media uploads were left out",
	media_url_relativized: "Media links were made relative",
	orphan_dropped: "Records without a parent were left out",
	orphan_reference_nulled: "Broken references were cleared",
	media_ref_unlinked: "Some media links could not be matched to files",
	unknown_storage_key:
		"Some content links to media files the source site doesn't have; those links won't work",
	principal_mapped: "Authors will be assigned to users on this site",
	principal_unmapped: "Some content will have no author",
	seeded_scaffold_removed: "Starter content will be removed",
	redirect_loop_disabled: "Redirects that loop will be imported turned off",
	search_unsupported: "Search will be turned off for some collections",
	float4_rounded: "Some decimal numbers will be rounded",
	locale_recased: "Locales will use this site's capitalization",
};

/** A plain-language description of a plan transformation code. */
export function transformationLabel(code: string): string {
	const labels: Readonly<Record<string, string>> = TRANSFORMATION_LABELS;
	return (Object.hasOwn(labels, code) ? labels[code] : undefined) ?? code;
}

function withServerDetail(friendly: string, serverMessage: string): string {
	return serverMessage && !friendly.includes(serverMessage)
		? `${friendly} (${serverMessage})`
		: friendly;
}

/** The code and user-facing message for any error `emdash site` can hit. */
export function describeError(error: unknown): CliErrorInfo {
	if (error instanceof EmDashApiError) {
		const friendly = TRANSFER_MESSAGES[error.code];
		return {
			code: error.code,
			message: friendly ? withServerDetail(friendly, error.message) : error.message,
		};
	}
	if (error instanceof SiteTransferCliError) {
		return { code: error.code, message: error.message };
	}
	if (isTransferError(error)) {
		const friendly = TRANSFER_MESSAGES[error.code];
		const path = typeof error.detail?.path === "string" ? ` [${error.detail.path}]` : "";
		return {
			code: error.code,
			message: `${friendly ? withServerDetail(friendly, error.message) : error.message}${path}`,
		};
	}
	return {
		code: "UNKNOWN_ERROR",
		message: error instanceof Error ? error.message : String(error),
	};
}

/** Describe a failed operation from its recorded error. */
export function operationError(operation: {
	id: string;
	state: string;
	errorCode: string | null;
	errorDetail: Record<string, unknown> | null;
}): SiteTransferCliError {
	const code = operation.errorCode ?? "TRANSFER_OPERATION_FAILED";
	const friendly = TRANSFER_MESSAGES[code];
	const base = friendly ?? `Operation ${operation.id} ended as ${operation.state}.`;
	return new SiteTransferCliError(
		code,
		friendly ? `${base} (operation ${operation.id} is ${operation.state})` : base,
		operation.errorDetail ?? undefined,
	);
}

export interface Reporter {
	/** A progress or status line for humans (stderr). */
	info(message: string): void;
	/** Something the user should notice but that does not stop the command. */
	warn(message: string): void;
}

export interface RetryOptions {
	/** Attempts including the first (default 5). */
	attempts?: number;
	/** First backoff delay in ms, doubled per retry up to 8 s (default 500). */
	baseDelayMs?: number;
}

export interface TransferRuntime {
	reporter: Reporter;
	retry?: RetryOptions;
	/** Waits between polls and retries; tests replace it. */
	sleep?: (ms: number) => Promise<void>;
}

export function sleepFor(runtime: TransferRuntime, ms: number): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	if (runtime.sleep) return runtime.sleep(ms);
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_BACKOFF_MS = 8000;

/** Network failures, timeouts, rate limits, and server errors are worth another try. */
export function isTransient(error: unknown): boolean {
	if (error instanceof EmDashApiError) {
		if (error.code === "TRANSFER_IMPORT_IN_PROGRESS") return false;
		return error.status === 408 || error.status === 429 || error.status >= 500;
	}
	if (error instanceof SiteTransferCliError || isTransferError(error)) return false;
	return error instanceof TypeError || (error instanceof Error && error.name === "AbortError");
}

/** Run `fn`, retrying transient failures with exponential backoff. */
export async function withRetry<T>(
	runtime: TransferRuntime,
	label: string,
	fn: () => Promise<T>,
): Promise<T> {
	const attempts = runtime.retry?.attempts ?? 5;
	const base = runtime.retry?.baseDelayMs ?? 500;
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn();
		} catch (error) {
			if (attempt >= attempts || !isTransient(error)) throw error;
			const delay = Math.min(base * 2 ** (attempt - 1), MAX_BACKOFF_MS);
			runtime.reporter.warn(
				`${label} failed (${describeError(error).message}); retrying in ${Math.round(delay / 100) / 10}s`,
			);
			await sleepFor(runtime, delay);
		}
	}
}

/** Emits a progress line at most once per interval, and always when the label changes. */
export function createProgressLogger(
	runtime: TransferRuntime,
	intervalMs = 2000,
): (label: string, detail?: string) => void {
	let lastLabel: string | undefined;
	let lastAt = 0;
	return (label, detail) => {
		const now = Date.now();
		if (label === lastLabel && now - lastAt < intervalMs) return;
		lastLabel = label;
		lastAt = now;
		runtime.reporter.info(detail ? `${label}: ${detail}` : label);
	};
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(1)} ${units[unit]}`;
}

export function formatProgress(
	progress: { done: number; total: number; bytesDone?: number; bytesTotal?: number } | null,
): string | undefined {
	if (!progress) return undefined;
	const bytes =
		progress.bytesTotal !== undefined && progress.bytesDone !== undefined
			? ` (${formatBytes(progress.bytesDone)} / ${formatBytes(progress.bytesTotal)})`
			: "";
	return `${progress.done}/${progress.total}${bytes}`;
}
