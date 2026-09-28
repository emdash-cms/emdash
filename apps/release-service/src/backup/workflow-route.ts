import { isDid } from "@atcute/lexicons/syntax";
import { env } from "cloudflare:workers";

import type { AccessActor } from "../access/auth.js";
import { readJsonObject } from "../api/body.js";
import { ApiError } from "../api/errors.js";
import { apiFailure, apiSuccess } from "../api/response.js";
import type { ServiceConfiguration } from "../config.js";
import { startPublisherArchiveWorkflow } from "../workflows/publisher-archive.js";

const ARCHIVE_START_PATH_PATTERN = /^\/admin\/api\/publishers\/([^/]+)\/archive\/start$/;
const ARCHIVE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

export interface ArchiveWorkflowRouteDependencies {
	startWorkflow?: typeof startPublisherArchiveWorkflow;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

export function matchPublisherArchiveStartPath(
	pathname: string,
): Readonly<Record<string, string>> | null {
	const match = ARCHIVE_START_PATH_PATTERN.exec(pathname);
	if (!match?.[1]) return null;
	let publisherDid: string;
	try {
		publisherDid = decodeURIComponent(match[1]);
	} catch {
		return null;
	}
	return isDid(publisherDid) ? { publisherDid } : null;
}

export async function handleStartPublisherArchive(
	request: Request,
	requestId: string,
	_configuration: ServiceConfiguration,
	params: Readonly<Record<string, string>>,
	accessActor: AccessActor | null,
	dependencies: ArchiveWorkflowRouteDependencies = {},
): Promise<Response> {
	try {
		if (!accessActor) {
			throw new ApiError("ACCESS_AUTH_REQUIRED", 401, "Access authentication required");
		}
		const idempotencyKey = request.headers.get("idempotency-key");
		if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
			throw new ApiError("IDEMPOTENCY_KEY_INVALID", 400, "Valid idempotency key required");
		}
		const publisherDid = params["publisherDid"];
		if (!publisherDid || !isDid(publisherDid)) {
			throw new ApiError("NOT_FOUND", 404, "Publisher not found");
		}
		const body = await readJsonObject(request);
		if (
			!hasExactKeys(body, ["archiveId"]) ||
			typeof body["archiveId"] !== "string" ||
			!ARCHIVE_ID_PATTERN.test(body["archiveId"])
		) {
			throw new ApiError("INVALID_REQUEST", 400, "Invalid publisher archive request");
		}
		const result = await (dependencies.startWorkflow ?? startPublisherArchiveWorkflow)(
			env.PUBLISHER_ARCHIVE_WORKFLOW,
			{
				publisherDid,
				archiveId: body["archiveId"],
				actorIdentity: accessActor.identity,
			},
		);
		if (!result.ok) {
			throw new ApiError("ARCHIVE_OPERATION_FAILED", 503, "Publisher archive could not start");
		}
		return apiSuccess(
			{ archiveId: body["archiveId"], workflowId: result.workflowId, created: result.created },
			requestId,
			result.created ? 202 : 200,
		);
	} catch (error) {
		return apiFailure(error, requestId);
	}
}
