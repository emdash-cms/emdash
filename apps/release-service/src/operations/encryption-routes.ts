import { isDid } from "@atcute/lexicons/syntax";
import { env } from "cloudflare:workers";

import type { AccessActor } from "../access/auth.js";
import { readJsonObject } from "../api/body.js";
import { ApiError } from "../api/errors.js";
import { apiFailure, apiSuccess } from "../api/response.js";
import type { ServiceConfiguration } from "../config.js";
import { EncryptionError } from "../crypto/encryption.js";
import type { EncryptionRecordPage, EncryptionRecordReplacement } from "./encryption-records.js";
import { MAX_ENCRYPTION_RECORD_PAGE } from "./encryption-records.js";

const PUBLISHER_ROTATION_PATH_PATTERN = /^\/admin\/api\/publishers\/([^/]+)\/encryption\/rotate$/;
const APPROVER_ROTATION_PATH_PATTERN = /^\/admin\/api\/approvers\/([^/]+)\/encryption\/rotate$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const PUBLISHER_CURSOR_PATTERN = /^(?:delegation:1|oauth-state:[A-Za-z0-9_-]{32,128})$/;
const APPROVER_CURSOR_PATTERN = /^identity-transaction:[A-Za-z0-9_-]{43}$/;
const RACED_CURSOR_PREFIX = "raced:";
const RESCAN_CURSOR = "rescan";

interface EncryptionShard {
	list(afterCursor: string | null, limit: number): Promise<EncryptionRecordPage>;
	replace(input: EncryptionRecordReplacement): Promise<boolean>;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function requireActor(actor: AccessActor | null): AccessActor {
	if (!actor) throw new ApiError("ACCESS_AUTH_REQUIRED", 401, "Access authentication required");
	return actor;
}

function requireIdempotencyKey(request: Request): void {
	const value = request.headers.get("idempotency-key");
	if (!value || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
		throw new ApiError("IDEMPOTENCY_KEY_INVALID", 400, "Valid idempotency key required");
	}
}

async function rotationPage(
	request: Request,
): Promise<{ afterCursor: string | null; limit: number }> {
	const body = await readJsonObject(request);
	if (
		!hasExactKeys(body, ["afterCursor", "limit"]) ||
		(body["afterCursor"] !== null && typeof body["afterCursor"] !== "string") ||
		!Number.isSafeInteger(body["limit"]) ||
		Number(body["limit"]) < 1 ||
		Number(body["limit"]) > MAX_ENCRYPTION_RECORD_PAGE
	) {
		throw new ApiError("INVALID_REQUEST", 400, "Invalid encryption rotation request");
	}
	return { afterCursor: body["afterCursor"], limit: Number(body["limit"]) };
}

function matchOwner(
	pathname: string,
	pattern: RegExp,
	key: "approverDid" | "publisherDid",
): Readonly<Record<string, string>> | null {
	const match = pattern.exec(pathname);
	if (!match?.[1]) return null;
	let did: string;
	try {
		did = decodeURIComponent(match[1]);
	} catch {
		return null;
	}
	return isDid(did) ? { [key]: did } : null;
}

function decodeRotationCursor(
	value: string | null,
	cursorPattern: RegExp,
): { afterCursor: string | null; raced: boolean } {
	if (value === null || value === RESCAN_CURSOR) return { afterCursor: null, raced: false };
	const raced = value.startsWith(RACED_CURSOR_PREFIX);
	const afterCursor = raced ? value.slice(RACED_CURSOR_PREFIX.length) : value;
	if (!cursorPattern.test(afterCursor)) {
		throw new ApiError("INVALID_REQUEST", 400, "Invalid encryption rotation cursor");
	}
	return { afterCursor, raced };
}

export function matchPublisherEncryptionRotationPath(
	pathname: string,
): Readonly<Record<string, string>> | null {
	return matchOwner(pathname, PUBLISHER_ROTATION_PATH_PATTERN, "publisherDid");
}

export function matchApproverEncryptionRotationPath(
	pathname: string,
): Readonly<Record<string, string>> | null {
	return matchOwner(pathname, APPROVER_ROTATION_PATH_PATTERN, "approverDid");
}

async function rotateEncryptionRecords(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	ownerDid: string,
	actor: AccessActor,
	shard: EncryptionShard,
	cursorPattern: RegExp,
): Promise<Response> {
	requireIdempotencyKey(request);
	const pageInput = await rotationPage(request);
	const cursor = decodeRotationCursor(pageInput.afterCursor, cursorPattern);
	const page = await shard.list(cursor.afterCursor, pageInput.limit);
	let rotated = 0;
	let raced = 0;
	for (const record of page.items) {
		let replacement;
		try {
			replacement = await configuration.encryption.rotate(record.envelope, record.context);
		} catch (error) {
			if (error instanceof EncryptionError) {
				throw new ApiError(
					"ENCRYPTION_OPERATION_FAILED",
					409,
					"Retained ciphertext could not be verified",
				);
			}
			throw error;
		}
		if (replacement.envelope === record.envelope && replacement.keyVersion === record.keyVersion) {
			continue;
		}
		const replaced = await shard.replace({
			cursor: record.cursor,
			expectedEnvelope: record.envelope,
			replacementEnvelope: replacement.envelope,
			replacementKeyVersion: replacement.keyVersion,
			actorIdentity: actor.identity,
		});
		if (replaced) rotated += 1;
		else raced += 1;
	}
	const raceSeen = cursor.raced || raced > 0;
	const nextCursor =
		page.nextCursor === null
			? raceSeen
				? RESCAN_CURSOR
				: null
			: raceSeen
				? `${RACED_CURSOR_PREFIX}${page.nextCursor}`
				: page.nextCursor;
	return apiSuccess(
		{
			ownerDid,
			targetKeyVersion: configuration.encryption.currentKeyVersion,
			scanned: page.items.length,
			rotated,
			raced,
			nextCursor,
			complete: nextCursor === null && rotated === 0 && raced === 0,
		},
		requestId,
	);
}

function routeFailure(error: unknown, requestId: string): Response {
	if (error instanceof ApiError) return apiFailure(error, requestId);
	throw error;
}

export async function handleRotatePublisherEncryption(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	params: Readonly<Record<string, string>>,
	accessActor: AccessActor | null,
): Promise<Response> {
	try {
		const actor = requireActor(accessActor);
		const publisherDid = params["publisherDid"];
		if (!publisherDid || !isDid(publisherDid)) {
			throw new ApiError("NOT_FOUND", 404, "Publisher not found");
		}
		const publisher = env.PUBLISHER_DO.getByName(publisherDid);
		return await rotateEncryptionRecords(
			request,
			requestId,
			configuration,
			publisherDid,
			actor,
			{
				list: (afterCursor, limit) =>
					publisher.listEncryptionRecords(publisherDid, afterCursor, limit),
				replace: (input) => publisher.replaceEncryptionRecord({ publisherDid, ...input }),
			},
			PUBLISHER_CURSOR_PATTERN,
		);
	} catch (error) {
		return routeFailure(error, requestId);
	}
}

export async function handleRotateApproverEncryption(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	params: Readonly<Record<string, string>>,
	accessActor: AccessActor | null,
): Promise<Response> {
	try {
		const actor = requireActor(accessActor);
		const approverDid = params["approverDid"];
		if (!approverDid || !isDid(approverDid)) {
			throw new ApiError("NOT_FOUND", 404, "Approver not found");
		}
		const approver = env.APPROVER_DO.getByName(approverDid);
		return await rotateEncryptionRecords(
			request,
			requestId,
			configuration,
			approverDid,
			actor,
			{
				list: (afterCursor, limit) =>
					approver.listEncryptionRecords(approverDid, afterCursor, limit),
				replace: (input) => approver.replaceEncryptionRecord({ approverDid, ...input }),
			},
			APPROVER_CURSOR_PATTERN,
		);
	} catch (error) {
		return routeFailure(error, requestId);
	}
}
