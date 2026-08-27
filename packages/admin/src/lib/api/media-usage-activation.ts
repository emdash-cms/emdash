import { API_BASE, apiFetch } from "./client.js";

const ACTIVATION_URL = `${API_BASE}/admin/media-usage/activation`;

export const MEDIA_USAGE_ACTIVATION_QUERY_KEY = ["media-usage-activation"] as const;
export const MEDIA_USAGE_PROGRESS_QUERY_KEY = ["media-usage-progress"] as const;

export interface MediaUsageActivationStatus {
	state: "expanded" | "activating" | "active";
	collectionCursor: string | null;
	attemptCount: number;
	drainConfirmedAt: string | null;
	lastAttemptedAt: string | null;
	lastErrorCode: "MEDIA_USAGE_ACTIVATION_FAILED" | null;
	leaseExpiresAt: string | null;
	activatedAt: string | null;
	updatedAt: string;
}

export interface MediaUsageActivationAdvanceResponse {
	outcome: "activating" | "active";
	processedCollections: number;
	activation: MediaUsageActivationStatus;
}

export interface MediaUsageProgress {
	status: "indexing" | "ready" | "needs_attention";
	readyCollections: number;
	totalCollections: number;
}

export interface MediaUsageProgressAdvanceResponse {
	activation: MediaUsageActivationStatus;
	progress: MediaUsageProgress | null;
	nextRequestInMs: 0 | 30_000 | null;
}

export type MediaUsageActivationErrorKind =
	| "busy"
	| "ownership_conflict"
	| "version_mismatch"
	| "denied"
	| "validation"
	| "read_failure"
	| "advance_failure"
	| "unknown";

export class MediaUsageActivationRequestError extends Error {
	constructor(
		readonly kind: MediaUsageActivationErrorKind,
		readonly status: number | null,
	) {
		super("Media usage activation request failed");
		this.name = "MediaUsageActivationRequestError";
	}
}

export async function fetchMediaUsageActivationStatus(): Promise<MediaUsageActivationStatus> {
	const response = await activationFetch(ACTIVATION_URL);
	if (!response.ok) throw await parseActivationError(response);
	const data = await readSuccessData(response);
	if (!isActivationStatus(data)) throw unknownResponse(response.status);
	return data;
}

export async function fetchMediaUsageProgress(): Promise<MediaUsageProgress> {
	const response = await activationFetch(`${API_BASE}/admin/media-usage/progress`);
	if (!response.ok) throw await parseActivationError(response);
	const data = await readSuccessData(response);
	if (!isMediaUsageProgress(data)) throw unknownResponse(response.status);
	return data;
}

export async function advanceMediaUsageProgress(): Promise<MediaUsageProgressAdvanceResponse> {
	const response = await activationFetch(`${API_BASE}/admin/media-usage/progress`, {
		method: "POST",
	});
	if (!response.ok) throw await parseActivationError(response);
	const data = await readSuccessData(response);
	if (!isProgressAdvanceResponse(data)) throw unknownResponse(response.status);
	return data;
}

export async function advanceMediaUsageActivation(input: {
	writersDrained: true;
}): Promise<MediaUsageActivationAdvanceResponse> {
	const response = await activationFetch(ACTIVATION_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			writersDrained: input.writersDrained,
		}),
	});
	if (!response.ok) throw await parseActivationError(response);
	const data = await readSuccessData(response);
	if (!isAdvanceResponse(data)) throw unknownResponse(response.status);
	return data;
}

async function activationFetch(input: string, init?: RequestInit): Promise<Response> {
	try {
		return await apiFetch(input, init);
	} catch {
		throw unknownResponse(null);
	}
}

async function parseActivationError(response: Response): Promise<MediaUsageActivationRequestError> {
	if (response.status === 401 || response.status === 403) {
		return new MediaUsageActivationRequestError("denied", response.status);
	}

	const body = await readJson(response);
	const error = isRecord(body) && isRecord(body.error) ? body.error : null;
	const code = error && typeof error.code === "string" ? error.code : null;

	switch (code) {
		case "MEDIA_USAGE_ACTIVATION_BUSY":
			return new MediaUsageActivationRequestError("busy", response.status);
		case "MEDIA_USAGE_ACTIVATION_CONFLICT":
			return new MediaUsageActivationRequestError("ownership_conflict", response.status);
		case "MEDIA_USAGE_ACTIVATION_VERSION_MISMATCH":
			return new MediaUsageActivationRequestError("version_mismatch", response.status);
		case "UNAUTHORIZED":
		case "FORBIDDEN":
		case "INSUFFICIENT_SCOPE":
			return new MediaUsageActivationRequestError("denied", response.status);
		case "VALIDATION_ERROR":
			return new MediaUsageActivationRequestError("validation", response.status);
		case "MEDIA_USAGE_ACTIVATION_READ_ERROR":
			return new MediaUsageActivationRequestError("read_failure", response.status);
		case "MEDIA_USAGE_ACTIVATION_ADVANCE_ERROR":
		case "MEDIA_USAGE_PROGRESS_ADVANCE_ERROR":
			return new MediaUsageActivationRequestError("advance_failure", response.status);
		default:
			return unknownResponse(response.status);
	}
}

function unknownResponse(status: number | null): MediaUsageActivationRequestError {
	return new MediaUsageActivationRequestError("unknown", status);
}

async function readSuccessData(response: Response): Promise<unknown> {
	const body = await readJson(response);
	if (!isRecord(body) || body.success !== true || !("data" in body)) return undefined;
	return body.data;
}

async function readJson(response: Response): Promise<unknown> {
	return response.json().catch(() => undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function isActivationStatus(value: unknown): value is MediaUsageActivationStatus {
	if (!isRecord(value)) return false;
	return (
		(value.state === "expanded" || value.state === "activating" || value.state === "active") &&
		isNullableString(value.collectionCursor) &&
		Number.isInteger(value.attemptCount) &&
		typeof value.attemptCount === "number" &&
		value.attemptCount >= 0 &&
		isNullableString(value.drainConfirmedAt) &&
		isNullableString(value.lastAttemptedAt) &&
		(value.lastErrorCode === null || value.lastErrorCode === "MEDIA_USAGE_ACTIVATION_FAILED") &&
		isNullableString(value.leaseExpiresAt) &&
		isNullableString(value.activatedAt) &&
		typeof value.updatedAt === "string"
	);
}

function isAdvanceResponse(value: unknown): value is MediaUsageActivationAdvanceResponse {
	if (!isRecord(value) || !isActivationStatus(value.activation)) return false;
	return (
		(value.outcome === "activating" || value.outcome === "active") &&
		value.activation.state === value.outcome &&
		typeof value.processedCollections === "number" &&
		Number.isInteger(value.processedCollections) &&
		value.processedCollections >= 0 &&
		value.processedCollections <= 1
	);
}

function isMediaUsageProgress(value: unknown): value is MediaUsageProgress {
	if (
		!isRecord(value) ||
		(value.status !== "indexing" && value.status !== "ready" && value.status !== "needs_attention")
	)
		return false;
	const ready = value.readyCollections;
	const total = value.totalCollections;
	if (
		typeof ready !== "number" ||
		!Number.isSafeInteger(ready) ||
		ready < 0 ||
		typeof total !== "number" ||
		!Number.isSafeInteger(total) ||
		total < ready
	)
		return false;
	return value.status !== "ready" || ready === total;
}

function isProgressAdvanceResponse(value: unknown): value is MediaUsageProgressAdvanceResponse {
	if (!isRecord(value) || !isActivationStatus(value.activation)) return false;
	if (value.progress !== null && !isMediaUsageProgress(value.progress)) return false;
	if ((value.activation.state === "active") !== (value.progress !== null)) return false;
	return (
		value.nextRequestInMs === 0 ||
		value.nextRequestInMs === 30_000 ||
		value.nextRequestInMs === null
	);
}
