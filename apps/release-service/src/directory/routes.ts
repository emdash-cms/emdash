import { env } from "cloudflare:workers";
import { base64url } from "jose";

import type { AccessActor } from "../access/auth.js";
import { ApiError } from "../api/errors.js";
import { apiFailure, apiSuccess } from "../api/response.js";
import type { ServiceConfiguration } from "../config.js";
import type { DirectoryIdentityKind } from "./identity-directory-do.js";

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const MAX_CURSOR_CHARS = 4096;

export interface DirectoryCursor {
	shard: number;
	afterDid: string | null;
}

function validCursor(value: DirectoryCursor): boolean {
	return (
		Number.isSafeInteger(value.shard) &&
		value.shard >= 0 &&
		value.shard <= 255 &&
		(value.afterDid === null || DID_PATTERN.test(value.afterDid))
	);
}

export function encodeDirectoryCursor(value: DirectoryCursor): string {
	if (!validCursor(value)) throw new TypeError("Invalid directory cursor");
	return base64url.encode(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeDirectoryCursor(value: string | null): DirectoryCursor {
	if (value === null) return { shard: 0, afterDid: null };
	if (value.length === 0 || value.length > MAX_CURSOR_CHARS) {
		throw new ApiError("INVALID_REQUEST", 400, "Invalid directory cursor");
	}
	let text: string;
	let parsed: unknown;
	try {
		const bytes = base64url.decode(value);
		if (base64url.encode(bytes) !== value) throw new Error();
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
		parsed = JSON.parse(text);
	} catch {
		throw new ApiError("INVALID_REQUEST", 400, "Invalid directory cursor");
	}
	if (
		parsed === null ||
		typeof parsed !== "object" ||
		Array.isArray(parsed) ||
		Object.keys(parsed).length !== 2 ||
		!("shard" in parsed) ||
		!("afterDid" in parsed)
	) {
		throw new ApiError("INVALID_REQUEST", 400, "Invalid directory cursor");
	}
	const rawShard = parsed.shard;
	const rawAfterDid = parsed.afterDid;
	if (typeof rawShard !== "number" || (rawAfterDid !== null && typeof rawAfterDid !== "string")) {
		throw new ApiError("INVALID_REQUEST", 400, "Invalid directory cursor");
	}
	const cursor: DirectoryCursor = { shard: rawShard, afterDid: rawAfterDid };
	if (!validCursor(cursor) || JSON.stringify(cursor) !== text) {
		throw new ApiError("INVALID_REQUEST", 400, "Invalid directory cursor");
	}
	return cursor;
}

function directoryKind(value: string | null): DirectoryIdentityKind {
	if (value !== "publisher" && value !== "approver") {
		throw new ApiError("INVALID_REQUEST", 400, "Directory kind is required");
	}
	return value;
}

function directoryLimit(value: string | null): number {
	if (value === null) return 50;
	if (!POSITIVE_INTEGER_PATTERN.test(value)) {
		throw new ApiError("INVALID_REQUEST", 400, "Invalid directory limit");
	}
	const limit = Number(value);
	if (!Number.isSafeInteger(limit) || limit > 100) {
		throw new ApiError("INVALID_REQUEST", 400, "Invalid directory limit");
	}
	return limit;
}

export async function handleListDirectory(
	request: Request,
	requestId: string,
	_configuration: ServiceConfiguration,
	_params: Readonly<Record<string, string>>,
	accessActor: AccessActor | null,
): Promise<Response> {
	try {
		if (!accessActor) {
			throw new ApiError("ACCESS_AUTH_REQUIRED", 401, "Access authentication required");
		}
		const url = new URL(request.url);
		const kind = directoryKind(url.searchParams.get("kind"));
		const limit = directoryLimit(url.searchParams.get("limit"));
		const cursor = decodeDirectoryCursor(url.searchParams.get("cursor"));
		if (
			url.searchParams.getAll("kind").length !== 1 ||
			url.searchParams.getAll("limit").length > 1 ||
			url.searchParams.getAll("cursor").length > 1
		) {
			throw new ApiError("INVALID_REQUEST", 400, "Invalid directory query");
		}
		const shard = cursor.shard.toString(16).padStart(2, "0");
		const items = await env.IDENTITY_DIRECTORY_DO.getByName(shard).list(
			kind,
			cursor.afterDid,
			limit,
		);
		const nextCursor =
			items.length === limit
				? encodeDirectoryCursor({ shard: cursor.shard, afterDid: items.at(-1)!.did })
				: cursor.shard < 255
					? encodeDirectoryCursor({ shard: cursor.shard + 1, afterDid: null })
					: null;
		return apiSuccess({ items: items.map((item) => ({ ...item, shard })), nextCursor }, requestId);
	} catch (error) {
		return apiFailure(error, requestId);
	}
}
