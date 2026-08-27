import { isDid } from "@atcute/lexicons/syntax";
import { env } from "cloudflare:workers";
import { base64url } from "jose";

import type { AccessActor } from "../access/auth.js";
import { readJsonObject } from "../api/body.js";
import { ApiError } from "../api/errors.js";
import { apiFailure, apiSuccess } from "../api/response.js";
import type { ServiceConfiguration } from "../config.js";
import { SERVICE_CONTROL_OBJECT_NAME } from "../control-do/service-control-do.js";
import type { EncryptionContext } from "../crypto/encryption.js";
import { writeOperationsMetric } from "../observability/metrics.js";

const ARCHIVE_PATH_PATTERN = /^\/admin\/api\/publishers\/([^/]+)\/archive$/;
const RESTORE_PATH_PATTERN = /^\/admin\/api\/publishers\/([^/]+)\/restore$/;
const RESTORE_PREPARE_PATH_PATTERN = /^\/admin\/api\/publishers\/([^/]+)\/restore\/prepare$/;
const RESTORE_ABORT_PATH_PATTERN = /^\/admin\/api\/publishers\/([^/]+)\/restore\/abort$/;
const ARCHIVE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const CURSOR_PATTERN =
	/^(?:workloads:[A-Za-z0-9_-]{0,64}|intents:[0-9A-HJKMNP-TV-Z]{0,26}|audit:[0-9]+)$/;
const WORKLOAD_PAGE_SIZE = 20;
const INTENT_PAGE_SIZE = 1;
const AUDIT_PAGE_SIZE = 100;
const MAX_ARCHIVE_PAGE = 999_999;
const MAX_ARCHIVE_OBJECT_BYTES = 1_500_000;
const SNAPSHOT_VERSION = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

type SnapshotKind = "audit-events" | "intents" | "metadata" | "workload-policies";

interface SnapshotPage {
	version: typeof SNAPSHOT_VERSION;
	archiveId: string;
	publisherDid: string;
	page: number;
	kind: SnapshotKind;
	data: unknown;
}

interface PageResult {
	kind: SnapshotKind;
	data: unknown;
	nextCursor: string | null;
	auditEvents?: readonly unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
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

async function archiveInput(
	request: Request,
): Promise<{ archiveId: string; cursor: string | null; page: number }> {
	const body = await readJsonObject(request);
	if (
		!hasExactKeys(body, ["archiveId", "cursor", "page"]) ||
		typeof body["archiveId"] !== "string" ||
		!ARCHIVE_ID_PATTERN.test(body["archiveId"]) ||
		(body["cursor"] !== null &&
			(typeof body["cursor"] !== "string" || !CURSOR_PATTERN.test(body["cursor"]))) ||
		!Number.isSafeInteger(body["page"]) ||
		Number(body["page"]) < 0 ||
		Number(body["page"]) > MAX_ARCHIVE_PAGE
	) {
		throw new ApiError("INVALID_REQUEST", 400, "Invalid publisher archive request");
	}
	return { archiveId: body["archiveId"], cursor: body["cursor"], page: Number(body["page"]) };
}

async function restoreInput(request: Request): Promise<{ archiveId: string; page: number }> {
	const body = await readJsonObject(request);
	if (
		!hasExactKeys(body, ["archiveId", "page"]) ||
		typeof body["archiveId"] !== "string" ||
		!ARCHIVE_ID_PATTERN.test(body["archiveId"]) ||
		!Number.isSafeInteger(body["page"]) ||
		Number(body["page"]) < 0 ||
		Number(body["page"]) > MAX_ARCHIVE_PAGE
	) {
		throw new ApiError("INVALID_REQUEST", 400, "Invalid publisher restore request");
	}
	return { archiveId: body["archiveId"], page: Number(body["page"]) };
}

async function hashOwner(publisherDid: string): Promise<string> {
	return base64url.encode(
		new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(publisherDid))),
	);
}

function snapshotContext(
	publisherDid: string,
	archiveId: string,
	primaryKey: string,
): EncryptionContext {
	return {
		purpose: "publisher-snapshot",
		objectClass: "PublisherDurableObject",
		table: "operations_archive",
		primaryKey: `${archiveId}:${primaryKey}`,
		ownerDid: publisherDid,
	};
}

async function writeEncryptedObject(
	key: string,
	plaintext: string,
	context: EncryptionContext,
	configuration: ServiceConfiguration,
	metadata: Record<string, string>,
): Promise<boolean> {
	const encrypted = await configuration.encryption.encrypt(encoder.encode(plaintext), context);
	const created = await env.OPERATIONS_ARCHIVE.put(key, encrypted.envelope, {
		onlyIf: { etagDoesNotMatch: "*" },
		httpMetadata: { contentType: "application/jose" },
		customMetadata: metadata,
	});
	if (created) return false;
	const existing = await env.OPERATIONS_ARCHIVE.get(key);
	if (!existing) throw new ApiError("ARCHIVE_OPERATION_FAILED", 503, "Archive write failed");
	if (existing.size > MAX_ARCHIVE_OBJECT_BYTES) {
		throw new ApiError("ARCHIVE_OPERATION_FAILED", 409, "Archive page conflicts with prior write");
	}
	let existingPlaintext: string;
	try {
		existingPlaintext = decoder.decode(
			await configuration.encryption.decrypt(await existing.text(), context),
		);
	} catch {
		throw new ApiError("ARCHIVE_OPERATION_FAILED", 409, "Archive page conflicts with prior write");
	}
	if (existingPlaintext !== plaintext) {
		throw new ApiError("ARCHIVE_OPERATION_FAILED", 409, "Archive page conflicts with prior write");
	}
	return true;
}

async function readEncryptedObject(
	key: string,
	context: EncryptionContext,
	configuration: ServiceConfiguration,
): Promise<string> {
	const object = await env.OPERATIONS_ARCHIVE.get(key);
	if (!object) throw new ApiError("NOT_FOUND", 404, "Publisher archive not found");
	if (object.size > MAX_ARCHIVE_OBJECT_BYTES) {
		throw new ApiError("RESTORE_OPERATION_FAILED", 409, "Publisher archive is invalid");
	}
	try {
		return decoder.decode(await configuration.encryption.decrypt(await object.text(), context));
	} catch {
		throw new ApiError("RESTORE_OPERATION_FAILED", 409, "Publisher archive is invalid");
	}
}

async function writeAuditObject(ownerHash: string, events: readonly unknown[]): Promise<void> {
	if (events.length === 0) return;
	const first = events[0];
	const last = events.at(-1);
	if (
		first === null ||
		typeof first !== "object" ||
		last === null ||
		typeof last !== "object" ||
		!("sequence" in first) ||
		!("sequence" in last) ||
		!Number.isSafeInteger(first.sequence) ||
		!Number.isSafeInteger(last.sequence)
	) {
		throw new ApiError("ARCHIVE_OPERATION_FAILED", 500, "Audit export failed");
	}
	const publicEvents = events.map((event) => {
		if (!isRecord(event) || typeof event["publicPayloadJson"] !== "string") {
			throw new ApiError("ARCHIVE_OPERATION_FAILED", 500, "Audit export failed");
		}
		let payload: unknown;
		try {
			payload = JSON.parse(event["publicPayloadJson"]);
		} catch {
			throw new ApiError("ARCHIVE_OPERATION_FAILED", 500, "Audit export failed");
		}
		if (!isRecord(payload) || JSON.stringify(payload) !== event["publicPayloadJson"]) {
			throw new ApiError("ARCHIVE_OPERATION_FAILED", 500, "Audit export failed");
		}
		return payload;
	});
	const firstSequence = String(first.sequence).padStart(20, "0");
	const lastSequence = String(last.sequence).padStart(20, "0");
	const content = JSON.stringify({ version: SNAPSHOT_VERSION, events: publicEvents });
	if (encoder.encode(content).byteLength > MAX_ARCHIVE_OBJECT_BYTES) {
		throw new ApiError("ARCHIVE_OPERATION_FAILED", 500, "Audit export exceeded its size limit");
	}
	const contentDigest = base64url.encode(
		new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(content))),
	);
	const key = `audit/${ownerHash}/${firstSequence}-${lastSequence}-${contentDigest}.json`;
	const created = await env.OPERATIONS_ARCHIVE.put(key, content, {
		onlyIf: { etagDoesNotMatch: "*" },
		httpMetadata: { contentType: "application/json" },
	});
	if (created) return;
	const existing = await env.OPERATIONS_ARCHIVE.get(key);
	if (
		!existing ||
		existing.size > MAX_ARCHIVE_OBJECT_BYTES ||
		(await existing.text()) !== content
	) {
		throw new ApiError("ARCHIVE_OPERATION_FAILED", 409, "Audit export conflicts with prior write");
	}
}

async function buildPage(publisherDid: string, cursor: string | null): Promise<PageResult> {
	const publisher = env.PUBLISHER_DO.getByName(publisherDid);
	if (cursor === null) {
		return {
			kind: "metadata",
			data: await publisher.getOperationsMetadata(publisherDid),
			nextCursor: "workloads:",
		};
	}
	if (cursor.startsWith("workloads:")) {
		const after = cursor.slice("workloads:".length) || null;
		const items = await publisher.listWorkloadPolicies(publisherDid, after, WORKLOAD_PAGE_SIZE);
		return {
			kind: "workload-policies",
			data: { items },
			nextCursor:
				items.length === WORKLOAD_PAGE_SIZE ? `workloads:${items.at(-1)!.packageSlug}` : "intents:",
		};
	}
	if (cursor.startsWith("intents:")) {
		const after = cursor.slice("intents:".length) || null;
		const intents = await publisher.listIntents(publisherDid, after, INTENT_PAGE_SIZE + 1);
		const items = intents.slice(0, INTENT_PAGE_SIZE);
		return {
			kind: "intents",
			data: { items },
			nextCursor: intents.length > INTENT_PAGE_SIZE ? `intents:${items.at(-1)!.id}` : "audit:0",
		};
	}
	const afterSequence = Number(cursor.slice("audit:".length));
	const items = await publisher.listAuditEvents(publisherDid, afterSequence, AUDIT_PAGE_SIZE);
	return {
		kind: "audit-events",
		data: { items },
		nextCursor: items.length === AUDIT_PAGE_SIZE ? `audit:${items.at(-1)!.sequence}` : null,
		auditEvents: items,
	};
}

export function matchPublisherArchivePath(
	pathname: string,
): Readonly<Record<string, string>> | null {
	const match = ARCHIVE_PATH_PATTERN.exec(pathname);
	if (!match?.[1]) return null;
	let publisherDid: string;
	try {
		publisherDid = decodeURIComponent(match[1]);
	} catch {
		return null;
	}
	return isDid(publisherDid) ? { publisherDid } : null;
}

export function matchPublisherRestorePath(
	pathname: string,
): Readonly<Record<string, string>> | null {
	const match = RESTORE_PATH_PATTERN.exec(pathname);
	if (!match?.[1]) return null;
	let publisherDid: string;
	try {
		publisherDid = decodeURIComponent(match[1]);
	} catch {
		return null;
	}
	return isDid(publisherDid) ? { publisherDid } : null;
}

export function matchPublisherRestorePreparePath(
	pathname: string,
): Readonly<Record<string, string>> | null {
	const match = RESTORE_PREPARE_PATH_PATTERN.exec(pathname);
	if (!match?.[1]) return null;
	let publisherDid: string;
	try {
		publisherDid = decodeURIComponent(match[1]);
	} catch {
		return null;
	}
	return isDid(publisherDid) ? { publisherDid } : null;
}

export function matchPublisherRestoreAbortPath(
	pathname: string,
): Readonly<Record<string, string>> | null {
	const match = RESTORE_ABORT_PATH_PATTERN.exec(pathname);
	if (!match?.[1]) return null;
	let publisherDid: string;
	try {
		publisherDid = decodeURIComponent(match[1]);
	} catch {
		return null;
	}
	return isDid(publisherDid) ? { publisherDid } : null;
}

export async function handleArchivePublisher(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	params: Readonly<Record<string, string>>,
	accessActor: AccessActor | null,
): Promise<Response> {
	try {
		requireActor(accessActor);
		requireIdempotencyKey(request);
		const publisherDid = params["publisherDid"];
		if (!publisherDid || !isDid(publisherDid)) {
			throw new ApiError("NOT_FOUND", 404, "Publisher not found");
		}
		const input = await archiveInput(request);
		const ownerHash = await hashOwner(publisherDid);
		const result = await buildPage(publisherDid, input.cursor);
		const snapshot: SnapshotPage = {
			version: SNAPSHOT_VERSION,
			archiveId: input.archiveId,
			publisherDid,
			page: input.page,
			kind: result.kind,
			data: result.data,
		};
		const key = `snapshots/${ownerHash}/${input.archiveId}/${String(input.page).padStart(6, "0")}.json.jwe`;
		const replayed = await writeEncryptedObject(
			key,
			JSON.stringify(snapshot),
			snapshotContext(publisherDid, input.archiveId, String(input.page)),
			configuration,
			{
				archive: input.archiveId,
				kind: result.kind,
				owner: ownerHash,
				page: String(input.page),
			},
		);
		if (result.auditEvents) {
			await writeAuditObject(ownerHash, result.auditEvents);
		}
		let manifestWritten = false;
		if (result.nextCursor === null) {
			const manifest = JSON.stringify({
				version: SNAPSHOT_VERSION,
				archiveId: input.archiveId,
				publisherDid,
				pages: input.page + 1,
				complete: true,
			});
			await writeEncryptedObject(
				`snapshots/${ownerHash}/${input.archiveId}/manifest.json.jwe`,
				manifest,
				snapshotContext(publisherDid, input.archiveId, "manifest"),
				configuration,
				{ archive: input.archiveId, owner: ownerHash, pages: String(input.page + 1) },
			);
			manifestWritten = true;
		}
		console.log(
			JSON.stringify({
				event: "publisher_archive_page",
				ownerHash,
				archiveId: input.archiveId,
				page: input.page,
				kind: result.kind,
				replayed,
				complete: result.nextCursor === null,
			}),
		);
		return apiSuccess(
			{
				archiveId: input.archiveId,
				ownerHash,
				page: input.page,
				kind: result.kind,
				nextCursor: result.nextCursor,
				nextPage: input.page + 1,
				replayed,
				complete: result.nextCursor === null,
				manifestWritten,
			},
			requestId,
		);
	} catch (error) {
		writeOperationsMetric({
			event: "archive_gap",
			outcome: error instanceof ApiError ? error.code : "internal",
			requestId,
		});
		if (error instanceof ApiError) return apiFailure(error, requestId);
		console.error(
			JSON.stringify({
				event: "publisher_archive_failed",
				requestId,
				name: error instanceof Error ? error.name : "UnknownError",
			}),
		);
		return apiFailure(
			new ApiError("ARCHIVE_OPERATION_FAILED", 503, "Publisher archive failed"),
			requestId,
		);
	}
}

function isSnapshotKind(value: unknown): value is SnapshotKind {
	return (
		value === "audit-events" ||
		value === "intents" ||
		value === "metadata" ||
		value === "workload-policies"
	);
}

function parseManifest(value: string, publisherDid: string, archiveId: string): { pages: number } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new ApiError("RESTORE_OPERATION_FAILED", 409, "Publisher archive is invalid");
	}
	if (
		!isRecord(parsed) ||
		!hasExactKeys(parsed, ["version", "archiveId", "publisherDid", "pages", "complete"]) ||
		parsed["version"] !== SNAPSHOT_VERSION ||
		parsed["archiveId"] !== archiveId ||
		parsed["publisherDid"] !== publisherDid ||
		!Number.isSafeInteger(parsed["pages"]) ||
		Number(parsed["pages"]) < 1 ||
		Number(parsed["pages"]) > MAX_ARCHIVE_PAGE + 1 ||
		parsed["complete"] !== true ||
		JSON.stringify(parsed) !== value
	) {
		throw new ApiError("RESTORE_OPERATION_FAILED", 409, "Publisher archive is invalid");
	}
	return { pages: Number(parsed["pages"]) };
}

function parseSnapshot(
	value: string,
	publisherDid: string,
	archiveId: string,
	page: number,
): SnapshotPage {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new ApiError("RESTORE_OPERATION_FAILED", 409, "Publisher archive is invalid");
	}
	if (
		!isRecord(parsed) ||
		!hasExactKeys(parsed, ["version", "archiveId", "publisherDid", "page", "kind", "data"]) ||
		parsed["version"] !== SNAPSHOT_VERSION ||
		parsed["archiveId"] !== archiveId ||
		parsed["publisherDid"] !== publisherDid ||
		parsed["page"] !== page ||
		!isSnapshotKind(parsed["kind"]) ||
		!isRecord(parsed["data"]) ||
		JSON.stringify(parsed) !== value
	) {
		throw new ApiError("RESTORE_OPERATION_FAILED", 409, "Publisher archive is invalid");
	}
	return {
		version: SNAPSHOT_VERSION,
		archiveId,
		publisherDid,
		page,
		kind: parsed["kind"],
		data: parsed["data"],
	};
}

async function digestPage(value: string): Promise<string> {
	return base64url.encode(
		new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))),
	);
}

export async function handleRestorePublisher(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	params: Readonly<Record<string, string>>,
	accessActor: AccessActor | null,
): Promise<Response> {
	try {
		const actor = requireActor(accessActor);
		requireIdempotencyKey(request);
		const publisherDid = params["publisherDid"];
		if (!publisherDid || !isDid(publisherDid)) {
			throw new ApiError("NOT_FOUND", 404, "Publisher not found");
		}
		const input = await restoreInput(request);
		const control = await env.SERVICE_CONTROL_DO.getByName(
			SERVICE_CONTROL_OBJECT_NAME,
		).readPublisherControl(actor, publisherDid);
		if (control.status !== "suspended") {
			throw new ApiError(
				"RESTORE_OPERATION_FAILED",
				409,
				"Suspend the publisher before restoring a shard",
			);
		}
		const ownerHash = await hashOwner(publisherDid);
		const prefix = `snapshots/${ownerHash}/${input.archiveId}`;
		const manifestPlaintext = await readEncryptedObject(
			`${prefix}/manifest.json.jwe`,
			snapshotContext(publisherDid, input.archiveId, "manifest"),
			configuration,
		);
		const manifest = parseManifest(manifestPlaintext, publisherDid, input.archiveId);
		if (input.page >= manifest.pages) {
			throw new ApiError("INVALID_REQUEST", 400, "Publisher restore page is out of range");
		}
		const pagePlaintext = await readEncryptedObject(
			`${prefix}/${String(input.page).padStart(6, "0")}.json.jwe`,
			snapshotContext(publisherDid, input.archiveId, String(input.page)),
			configuration,
		);
		const snapshot = parseSnapshot(pagePlaintext, publisherDid, input.archiveId, input.page);
		const result = await env.PUBLISHER_DO.getByName(publisherDid).applyOperationsRestorePage({
			publisherDid,
			archiveId: input.archiveId,
			page: input.page,
			totalPages: manifest.pages,
			kind: snapshot.kind,
			dataJson: JSON.stringify(snapshot.data),
			pageDigest: await digestPage(pagePlaintext),
			actorIdentity: actor.identity,
		});
		if (!result.ok) {
			const message =
				result.code === "RESTORE_NOT_EMPTY"
					? "Publisher shard is not empty"
					: result.code === "RESTORE_OUT_OF_ORDER"
						? "Publisher restore page is out of order"
						: "Publisher restore conflicts with prior state";
			throw new ApiError("RESTORE_OPERATION_FAILED", 409, message);
		}
		console.log(
			JSON.stringify({
				event: "publisher_restore_page",
				ownerHash,
				archiveId: input.archiveId,
				page: input.page,
				kind: snapshot.kind,
				replayed: result.replayed,
				complete: result.complete,
			}),
		);
		return apiSuccess(
			{
				archiveId: input.archiveId,
				ownerHash,
				page: input.page,
				kind: snapshot.kind,
				nextPage: result.nextPage,
				totalPages: manifest.pages,
				replayed: result.replayed,
				complete: result.complete,
				authorityStatus: "reauthorization_required",
			},
			requestId,
		);
	} catch (error) {
		writeOperationsMetric({
			event: "restore_failure",
			outcome: error instanceof ApiError ? error.code : "internal",
			requestId,
		});
		if (error instanceof ApiError) return apiFailure(error, requestId);
		console.error(
			JSON.stringify({
				event: "publisher_restore_failed",
				requestId,
				name: error instanceof Error ? error.name : "UnknownError",
			}),
		);
		return apiFailure(
			new ApiError("RESTORE_OPERATION_FAILED", 503, "Publisher restore failed"),
			requestId,
		);
	}
}

export async function handlePreparePublisherRestore(
	request: Request,
	requestId: string,
	configuration: ServiceConfiguration,
	params: Readonly<Record<string, string>>,
	accessActor: AccessActor | null,
): Promise<Response> {
	try {
		const actor = requireActor(accessActor);
		requireIdempotencyKey(request);
		const publisherDid = params["publisherDid"];
		if (!publisherDid || !isDid(publisherDid)) {
			throw new ApiError("NOT_FOUND", 404, "Publisher not found");
		}
		const body = await readJsonObject(request);
		if (
			!hasExactKeys(body, ["archiveId", "confirmPublisherDid"]) ||
			typeof body["archiveId"] !== "string" ||
			!ARCHIVE_ID_PATTERN.test(body["archiveId"]) ||
			body["confirmPublisherDid"] !== publisherDid
		) {
			throw new ApiError("INVALID_REQUEST", 400, "Publisher restore confirmation is invalid");
		}
		const control = await env.SERVICE_CONTROL_DO.getByName(
			SERVICE_CONTROL_OBJECT_NAME,
		).readPublisherControl(actor, publisherDid);
		if (control.status !== "suspended") {
			throw new ApiError(
				"RESTORE_OPERATION_FAILED",
				409,
				"Suspend the publisher before preparing a restore",
			);
		}
		const ownerHash = await hashOwner(publisherDid);
		const manifestPlaintext = await readEncryptedObject(
			`snapshots/${ownerHash}/${body["archiveId"]}/manifest.json.jwe`,
			snapshotContext(publisherDid, body["archiveId"], "manifest"),
			configuration,
		);
		const manifest = parseManifest(manifestPlaintext, publisherDid, body["archiveId"]);
		const publisher = env.PUBLISHER_DO.getByName(publisherDid);
		await publisher.setPublisherSuspended(publisherDid, true, actor.identity);
		const result = await publisher.prepareOperationsRestore(
			publisherDid,
			body["archiveId"],
			manifest.pages,
			actor.identity,
		);
		if (!result.ok) {
			throw new ApiError(
				"RESTORE_OPERATION_FAILED",
				409,
				result.code === "PUBLISHER_NOT_SUSPENDED"
					? "Publisher is not suspended"
					: "Another publisher restore is already in progress",
			);
		}
		return apiSuccess(
			{
				archiveId: body["archiveId"],
				publisherDid,
				prepared: true,
				deletedIntents: result.deletedIntents,
				deletedWorkloads: result.deletedWorkloads,
				replayed: result.replayed,
			},
			requestId,
		);
	} catch (error) {
		writeOperationsMetric({
			event: "restore_failure",
			outcome: error instanceof ApiError ? error.code : "internal",
			requestId,
		});
		if (error instanceof ApiError) return apiFailure(error, requestId);
		return apiFailure(
			new ApiError("RESTORE_OPERATION_FAILED", 503, "Publisher restore preparation failed"),
			requestId,
		);
	}
}

export async function handleAbortPublisherRestore(
	request: Request,
	requestId: string,
	_configuration: ServiceConfiguration,
	params: Readonly<Record<string, string>>,
	accessActor: AccessActor | null,
): Promise<Response> {
	try {
		const actor = requireActor(accessActor);
		requireIdempotencyKey(request);
		const publisherDid = params["publisherDid"];
		if (!publisherDid || !isDid(publisherDid)) {
			throw new ApiError("NOT_FOUND", 404, "Publisher not found");
		}
		const body = await readJsonObject(request);
		if (
			!hasExactKeys(body, ["archiveId", "confirmPublisherDid"]) ||
			typeof body["archiveId"] !== "string" ||
			!ARCHIVE_ID_PATTERN.test(body["archiveId"]) ||
			body["confirmPublisherDid"] !== publisherDid
		) {
			throw new ApiError("INVALID_REQUEST", 400, "Publisher restore confirmation is invalid");
		}
		const control = await env.SERVICE_CONTROL_DO.getByName(
			SERVICE_CONTROL_OBJECT_NAME,
		).readPublisherControl(actor, publisherDid);
		if (control.status !== "suspended") {
			throw new ApiError(
				"RESTORE_OPERATION_FAILED",
				409,
				"Suspend the publisher before aborting a restore",
			);
		}
		const result = await env.PUBLISHER_DO.getByName(publisherDid).abortOperationsRestore(
			publisherDid,
			body["archiveId"],
			actor.identity,
		);
		if (!result.ok) {
			throw new ApiError(
				"RESTORE_OPERATION_FAILED",
				409,
				result.code === "PUBLISHER_NOT_SUSPENDED"
					? "Publisher is not suspended"
					: "Publisher restore cannot be aborted",
			);
		}
		console.log(
			JSON.stringify({
				event: "publisher_restore_aborted",
				archiveId: body["archiveId"],
				publisherHash: await hashOwner(publisherDid),
				replayed: result.replayed,
			}),
		);
		return apiSuccess(
			{
				archiveId: body["archiveId"],
				publisherDid,
				aborted: true,
				replayed: result.replayed,
			},
			requestId,
		);
	} catch (error) {
		writeOperationsMetric({
			event: "restore_failure",
			outcome: error instanceof ApiError ? error.code : "internal",
			requestId,
		});
		if (error instanceof ApiError) return apiFailure(error, requestId);
		return apiFailure(
			new ApiError("RESTORE_OPERATION_FAILED", 503, "Publisher restore abort failed"),
			requestId,
		);
	}
}
