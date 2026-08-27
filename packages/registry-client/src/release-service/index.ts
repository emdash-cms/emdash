import type { PackageRelease } from "@emdash-cms/registry-lexicons";

import {
	TERMINAL_RELEASE_INTENT_STATES,
	type CursorPage,
	type DelegationResource,
	type MutationResult,
	type OperatorPublisherResource,
	type PublisherControlResource,
	type PublisherResource,
	type PutWorkloadPolicyInput,
	type ReleaseIntentResource,
	type ReleaseIntentResult,
	type ReleaseIntentState,
	type ReleaseServiceApiErrorCode,
	type ReleaseServiceClientErrorCode,
	type ServiceControlState,
	type SubmitReleaseIntentInput,
	type SubmitReleaseIntentResult,
	type WorkloadPolicyResource,
} from "./types.js";

export type {
	CursorPage,
	DelegationResource,
	MutationResult,
	OperatorPublisherResource,
	PublisherControlResource,
	PublisherResource,
	PutWorkloadPolicyInput,
	ReleaseIntentResource,
	ReleaseIntentResult,
	ReleaseIntentState,
	ReleaseServiceApiErrorCode,
	ReleaseServiceClientErrorCode,
	ServiceControlState,
	SubmitReleaseIntentInput,
	SubmitReleaseIntentResult,
	WorkloadPolicyResource,
} from "./types.js";
export { TERMINAL_RELEASE_INTENT_STATES } from "./types.js";

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PACKAGE_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.-]{0,127}$/;
const CID_PATTERN = /^[A-Za-z0-9]+$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const IDEMPOTENCY_PREFIX_PATTERN = /[^A-Za-z0-9._:-]/g;
const DIGITS_PATTERN = /^[0-9]+$/;
const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const API_ERROR_CODES: Readonly<Record<ReleaseServiceApiErrorCode, true>> = {
	ACCESS_DENIED: true,
	ACCESS_AUTH_INVALID: true,
	ACCESS_AUTH_REQUIRED: true,
	APPROVAL_INVALID: true,
	APPROVER_SESSION_INVALID: true,
	APPROVER_SUSPENDED: true,
	AUTH_INVALID: true,
	CONFIGURATION_ERROR: true,
	CREDENTIAL_LIMIT_REACHED: true,
	CREDENTIAL_NOT_FOUND: true,
	CREDENTIAL_REVOKED: true,
	CSRF_INVALID: true,
	DELEGATION_REQUIRED: true,
	IDEMPOTENCY_KEY_INVALID: true,
	IDEMPOTENCY_CONFLICT: true,
	INTERNAL_ERROR: true,
	INVALID_REQUEST: true,
	INTENT_NOT_APPROVABLE: true,
	INTENT_NOT_CANCELLABLE: true,
	METHOD_NOT_ALLOWED: true,
	NOT_FOUND: true,
	OAUTH_AUTHORIZATION_FAILED: true,
	OAUTH_CALLBACK_INVALID: true,
	PROFILE_CHANGED: true,
	PROFILE_FETCH_FAILED: true,
	PUBLISHER_SESSION_INVALID: true,
	PUBLISHER_SUSPENDED: true,
	RELEASE_EXISTS: true,
	SERVICE_PAUSED: true,
	SERVICE_UNAVAILABLE: true,
	VERSION_RESERVED: true,
	WORKFLOW_UNAVAILABLE: true,
	WORKLOAD_NOT_ALLOWED: true,
};
const RETRYABLE_ERROR_CODES: ReadonlySet<ReleaseServiceClientErrorCode> = new Set([
	"CONFIGURATION_ERROR",
	"INTERNAL_ERROR",
	"NETWORK_ERROR",
	"PROFILE_FETCH_FAILED",
	"PUBLISHER_SUSPENDED",
	"SERVICE_PAUSED",
	"SERVICE_UNAVAILABLE",
	"WORKFLOW_UNAVAILABLE",
]);
const INTENT_STATES: Readonly<Record<ReleaseIntentState, true>> = {
	received: true,
	verifying: true,
	verified: true,
	awaiting_approval: true,
	ready: true,
	publishing: true,
	reconciling: true,
	published: true,
	invalid: true,
	rejected: true,
	cancelled: true,
	expired: true,
	failed: true,
	conflict: true,
};

type WorkloadTokenProvider = () => string | Promise<string>;
type CsrfTokenProvider = () => string | Promise<string>;

export interface ReleaseServiceClientOptions {
	serviceUrl: string;
	fetch?: typeof fetch;
	workloadToken?: string | WorkloadTokenProvider;
	csrfToken?: string | CsrfTokenProvider;
}

export interface RequestOptions {
	signal?: AbortSignal;
}

export interface MutationOptions extends RequestOptions {
	idempotencyKey: string;
}

export interface WaitForIntentOptions extends RequestOptions {
	pollIntervalMs?: number;
	maxWaitMs?: number;
	stopOnApproval?: boolean;
	onUpdate?: (intent: ReleaseIntentResource) => void | Promise<void>;
}

export interface OperatorClientOptions {
	serviceUrl: string;
	fetch?: typeof fetch;
}

export class ReleaseServiceError extends Error {
	readonly code: ReleaseServiceClientErrorCode;
	readonly status: number;
	readonly requestId: string | null;
	readonly retryable: boolean;
	readonly retryAfterMs: number | null;

	constructor(input: {
		code: ReleaseServiceClientErrorCode;
		message: string;
		status?: number;
		requestId?: string | null;
		retryAfterMs?: number | null;
	}) {
		super(input.message);
		this.name = "ReleaseServiceError";
		this.code = input.code;
		this.status = input.status ?? 0;
		this.requestId = input.requestId ?? null;
		this.retryable = RETRYABLE_ERROR_CODES.has(input.code);
		this.retryAfterMs = input.retryAfterMs ?? null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIntentState(value: unknown): value is ReleaseIntentState {
	return typeof value === "string" && Object.hasOwn(INTENT_STATES, value);
}

function isApiErrorCode(value: unknown): value is ReleaseServiceApiErrorCode {
	return typeof value === "string" && Object.hasOwn(API_ERROR_CODES, value);
}

function serviceOrigin(value: string): string {
	try {
		const url = new URL(value);
		const loopback =
			url.protocol === "http:" &&
			(url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
		if (
			(url.protocol !== "https:" && !loopback) ||
			url.username !== "" ||
			url.password !== "" ||
			url.pathname !== "/" ||
			url.search !== "" ||
			url.hash !== "" ||
			url.origin !== value
		) {
			throw new Error("invalid origin");
		}
		return url.origin;
	} catch {
		throw new ReleaseServiceError({
			code: "CLIENT_RESPONSE_INVALID",
			message: "Release service URL must be an HTTPS origin or a loopback development origin",
		});
	}
}

function requireIdempotencyKey(value: string): string {
	if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
		throw new ReleaseServiceError({
			code: "IDEMPOTENCY_KEY_INVALID",
			message: "Idempotency key is invalid",
		});
	}
	return value;
}

export function createReleaseIdempotencyKey(prefix = "emdash"): string {
	const normalized = prefix.replaceAll(IDEMPOTENCY_PREFIX_PATTERN, "-").slice(0, 64);
	const value = `${normalized || "emdash"}-${crypto.randomUUID()}`;
	return requireIdempotencyKey(value);
}

function stringValue(value: Record<string, unknown>, key: string): string | null {
	const item = value[key];
	return typeof item === "string" ? item : null;
}

function nullableString(value: Record<string, unknown>, key: string): string | null | undefined {
	const item = value[key];
	return item === null || typeof item === "string" ? item : undefined;
}

function safeInteger(value: Record<string, unknown>, key: string): number | null {
	const item = value[key];
	return Number.isSafeInteger(item) ? Number(item) : null;
}

function parseIntentResult(value: unknown): ReleaseIntentResult | null | undefined {
	if (value === null) return null;
	if (!isRecord(value)) return undefined;
	const uri = stringValue(value, "uri");
	const cid = stringValue(value, "cid");
	return uri && cid ? { uri, cid } : undefined;
}

function parseIntent(value: unknown, serviceUrl?: string): ReleaseIntentResource {
	if (!isRecord(value)) throw invalidResponse();
	const id = stringValue(value, "id");
	const publisherDid = stringValue(value, "publisherDid");
	const packageSlug = stringValue(value, "packageSlug");
	const version = stringValue(value, "version");
	const state = value["state"];
	const stateGeneration = safeInteger(value, "stateGeneration");
	const reasonCode = nullableString(value, "reasonCode");
	const workflowId = nullableString(value, "workflowId");
	const expiresAt = safeInteger(value, "expiresAt");
	const createdAt = safeInteger(value, "createdAt");
	const updatedAt = safeInteger(value, "updatedAt");
	const result = parseIntentResult(value["result"]);
	const approvalUrl = nullableString(value, "approvalUrl");
	if (
		!id ||
		!ULID_PATTERN.test(id) ||
		!publisherDid ||
		!DID_PATTERN.test(publisherDid) ||
		!packageSlug ||
		!PACKAGE_SLUG_PATTERN.test(packageSlug) ||
		!version ||
		!VERSION_PATTERN.test(version) ||
		!isIntentState(state) ||
		stateGeneration === null ||
		stateGeneration < 1 ||
		reasonCode === undefined ||
		workflowId === undefined ||
		expiresAt === null ||
		createdAt === null ||
		updatedAt === null ||
		result === undefined ||
		approvalUrl === undefined ||
		(workflowId !== null && !ULID_PATTERN.test(workflowId)) ||
		createdAt > updatedAt ||
		updatedAt > expiresAt ||
		(result !== null &&
			(result.uri !==
				`at://${publisherDid}/com.emdashcms.experimental.package.release/${packageSlug}:${version}` ||
				!CID_PATTERN.test(result.cid)))
	) {
		throw invalidResponse();
	}
	if (approvalUrl !== null && serviceUrl) {
		let parsedApproval: URL;
		try {
			parsedApproval = new URL(approvalUrl);
		} catch {
			throw invalidResponse();
		}
		if (parsedApproval.origin !== serviceUrl || parsedApproval.protocol !== "https:") {
			throw invalidResponse();
		}
	}
	return {
		id,
		publisherDid,
		packageSlug,
		version,
		state,
		stateGeneration,
		reasonCode,
		workflowId,
		expiresAt,
		createdAt,
		updatedAt,
		result,
		approvalUrl,
	};
}

function parseStringArray(value: unknown): readonly string[] | null {
	return Array.isArray(value) && value.every((item) => typeof item === "string")
		? [...value]
		: null;
}

function parsePolicy(value: unknown): WorkloadPolicyResource {
	if (!isRecord(value)) throw invalidResponse();
	const packageSlug = stringValue(value, "packageSlug");
	const repository = stringValue(value, "repository");
	const repositoryId = stringValue(value, "repositoryId");
	const repositoryOwnerId = stringValue(value, "repositoryOwnerId");
	const workflowRef = stringValue(value, "workflowRef");
	const allowedRefs = parseStringArray(value["allowedRefs"]);
	const allowedEnvironments = parseStringArray(value["allowedEnvironments"]);
	const stateVersion = safeInteger(value, "stateVersion");
	const authorizedBy = stringValue(value, "authorizedBy");
	const createdAt = safeInteger(value, "createdAt");
	const updatedAt = safeInteger(value, "updatedAt");
	if (
		!packageSlug ||
		!repository ||
		!repositoryId ||
		!repositoryOwnerId ||
		!workflowRef ||
		!allowedRefs ||
		!allowedEnvironments ||
		typeof value["active"] !== "boolean" ||
		stateVersion === null ||
		!authorizedBy ||
		createdAt === null ||
		updatedAt === null
	) {
		throw invalidResponse();
	}
	return {
		packageSlug,
		repository,
		repositoryId,
		repositoryOwnerId,
		workflowRef,
		allowedRefs,
		allowedEnvironments,
		active: value["active"],
		stateVersion,
		authorizedBy,
		createdAt,
		updatedAt,
	};
}

function parseDelegation(value: unknown): DelegationResource | null {
	if (value === null) return null;
	if (!isRecord(value)) throw invalidResponse();
	const releaseNsid = stringValue(value, "releaseNsid");
	const scope = stringValue(value, "scope");
	const issuer = nullableString(value, "issuer");
	const pdsUrl = nullableString(value, "pdsUrl");
	const expiresAt = value["expiresAt"];
	const refreshBefore = value["refreshBefore"];
	const status = value["status"];
	const stateVersion = safeInteger(value, "stateVersion");
	if (
		!releaseNsid ||
		!scope ||
		issuer === undefined ||
		pdsUrl === undefined ||
		(expiresAt !== null && !Number.isSafeInteger(expiresAt)) ||
		(refreshBefore !== null && !Number.isSafeInteger(refreshBefore)) ||
		(status !== "active" && status !== "revoked" && status !== "reauthorization_required") ||
		stateVersion === null
	) {
		throw invalidResponse();
	}
	return {
		releaseNsid,
		scope,
		issuer,
		pdsUrl,
		expiresAt: expiresAt === null ? null : Number(expiresAt),
		refreshBefore: refreshBefore === null ? null : Number(refreshBefore),
		status,
		stateVersion,
	};
}

function parsePublisher(value: unknown): PublisherResource {
	if (!isRecord(value)) throw invalidResponse();
	const did = stringValue(value, "did");
	const delegation = parseDelegation(value["delegation"]);
	const sessionExpiresAt = value["sessionExpiresAt"];
	if (
		!did ||
		!DID_PATTERN.test(did) ||
		(sessionExpiresAt !== undefined && !Number.isSafeInteger(sessionExpiresAt))
	) {
		throw invalidResponse();
	}
	return {
		did,
		delegation,
		...(sessionExpiresAt === undefined ? {} : { sessionExpiresAt: Number(sessionExpiresAt) }),
	};
}

function parseServiceState(value: unknown): ServiceControlState {
	if (!isRecord(value)) throw invalidResponse();
	const mode = value["mode"];
	const epoch = safeInteger(value, "epoch");
	const reasonCode = nullableString(value, "reasonCode");
	const changedBy = stringValue(value, "changedBy");
	const changedAt = safeInteger(value, "changedAt");
	if (
		(mode !== "active" && mode !== "admission-paused" && mode !== "publication-paused") ||
		epoch === null ||
		reasonCode === undefined ||
		!changedBy ||
		changedAt === null
	) {
		throw invalidResponse();
	}
	return { mode, epoch, reasonCode, changedBy, changedAt };
}

function parsePublisherControl(value: unknown): PublisherControlResource {
	if (!isRecord(value)) throw invalidResponse();
	const publisherDid = stringValue(value, "publisherDid");
	const status = value["status"];
	const reasonCode = nullableString(value, "reasonCode");
	const changedBy = stringValue(value, "changedBy");
	const changedAt = safeInteger(value, "changedAt");
	if (
		!publisherDid ||
		(status !== "allowed" && status !== "suspended") ||
		reasonCode === undefined ||
		!changedBy ||
		changedAt === null
	) {
		throw invalidResponse();
	}
	return { publisherDid, status, reasonCode, changedBy, changedAt };
}

function invalidResponse(requestId: string | null = null): ReleaseServiceError {
	return new ReleaseServiceError({
		code: "CLIENT_RESPONSE_INVALID",
		message: "Release service returned an invalid response",
		status: 502,
		requestId,
	});
}

function retryAfterMs(response: Response): number | null {
	const value = response.headers.get("retry-after");
	if (!value) return null;
	if (DIGITS_PATTERN.test(value)) return Number(value) * 1000;
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function parseErrorPayload(
	value: unknown,
	response: Response,
): { code: ReleaseServiceApiErrorCode; message: string; requestId: string | null } {
	if (!isRecord(value) || !isRecord(value["error"])) throw invalidResponse();
	const code = stringValue(value["error"], "code");
	const message = stringValue(value["error"], "message");
	const requestId = nullableString(value, "requestId");
	if (!isApiErrorCode(code) || !message || requestId === undefined) {
		throw invalidResponse(response.headers.get("x-request-id"));
	}
	return { code, message, requestId };
}

async function responseJson(response: Response): Promise<unknown> {
	const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (mediaType !== "application/json") throw invalidResponse(response.headers.get("x-request-id"));
	try {
		return await response.json();
	} catch {
		throw invalidResponse(response.headers.get("x-request-id"));
	}
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw signal.reason;
	await new Promise<void>((resolve, reject) => {
		const complete = () => {
			signal?.removeEventListener("abort", abort);
			resolve();
		};
		const timer = setTimeout(complete, ms);
		const abort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

class BaseReleaseServiceClient {
	readonly serviceUrl: string;
	readonly fetch: typeof fetch;

	constructor(options: { serviceUrl: string; fetch?: typeof fetch }) {
		this.serviceUrl = serviceOrigin(options.serviceUrl);
		this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
	}

	protected async call<T>(
		path: string,
		init: RequestInit,
		parse: (value: unknown) => T,
	): Promise<T> {
		let response: Response;
		try {
			response = await this.fetch(new URL(path, this.serviceUrl), init);
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") throw error;
			throw new ReleaseServiceError({
				code: "NETWORK_ERROR",
				message: "Release service request failed",
			});
		}
		const payload = await responseJson(response);
		if (!response.ok) {
			const error = parseErrorPayload(payload, response);
			throw new ReleaseServiceError({
				...error,
				status: response.status,
				retryAfterMs: retryAfterMs(response),
			});
		}
		if (!isRecord(payload) || !("data" in payload)) {
			throw invalidResponse(response.headers.get("x-request-id"));
		}
		return parse(payload["data"]);
	}
}

export class ReleaseServiceClient extends BaseReleaseServiceClient {
	readonly #workloadToken: string | WorkloadTokenProvider | undefined;
	readonly #csrfToken: string | CsrfTokenProvider | undefined;

	constructor(options: ReleaseServiceClientOptions) {
		super(options);
		this.#workloadToken = options.workloadToken;
		this.#csrfToken = options.csrfToken;
	}

	async #token(): Promise<string> {
		const token =
			typeof this.#workloadToken === "function" ? await this.#workloadToken() : this.#workloadToken;
		if (!token || token.length > 16 * 1024 || token.includes(" ")) {
			throw new ReleaseServiceError({
				code: "AUTH_INVALID",
				message: "Workload token is unavailable",
			});
		}
		return token;
	}

	async #csrf(): Promise<string> {
		const token = typeof this.#csrfToken === "function" ? await this.#csrfToken() : this.#csrfToken;
		if (!token || !CSRF_TOKEN_PATTERN.test(token)) {
			throw new ReleaseServiceError({
				code: "CSRF_INVALID",
				message: "Publisher CSRF token is unavailable",
			});
		}
		return token;
	}

	async #workloadHeaders(idempotencyKey?: string): Promise<Headers> {
		const headers = new Headers({ authorization: `Bearer ${await this.#token()}` });
		if (idempotencyKey) headers.set("idempotency-key", requireIdempotencyKey(idempotencyKey));
		return headers;
	}

	async #publisherMutationHeaders(idempotencyKey: string): Promise<Headers> {
		return new Headers({
			"content-type": "application/json",
			"idempotency-key": requireIdempotencyKey(idempotencyKey),
			"x-emdash-request": "1",
			"x-emdash-csrf": await this.#csrf(),
		});
	}

	async submitIntent(
		input: SubmitReleaseIntentInput,
		options: MutationOptions,
	): Promise<SubmitReleaseIntentResult> {
		const headers = await this.#workloadHeaders(options.idempotencyKey);
		headers.set("content-type", "application/json");
		return await this.call(
			"/v1/release-intents",
			{
				method: "POST",
				headers,
				body: JSON.stringify(input),
				signal: options.signal,
			},
			(value) => {
				if (!isRecord(value) || typeof value["replayed"] !== "boolean") {
					throw invalidResponse();
				}
				return {
					intent: parseIntent(value["intent"], this.serviceUrl),
					replayed: value["replayed"],
				};
			},
		);
	}

	async getIntent(
		publisherDid: string,
		intentId: string,
		options: RequestOptions = {},
	): Promise<ReleaseIntentResource> {
		const headers = await this.#workloadHeaders();
		return await this.call(
			`/v1/release-intents/${encodeURIComponent(intentId)}?publisher=${encodeURIComponent(publisherDid)}`,
			{ method: "GET", headers, signal: options.signal },
			(value) => {
				if (!isRecord(value)) throw invalidResponse();
				return parseIntent(value["intent"], this.serviceUrl);
			},
		);
	}

	async cancelIntent(
		publisherDid: string,
		intentId: string,
		options: MutationOptions,
	): Promise<ReleaseIntentResource> {
		const headers = await this.#workloadHeaders(options.idempotencyKey);
		headers.set("content-type", "application/json");
		return await this.call(
			`/v1/release-intents/${encodeURIComponent(intentId)}/cancel?publisher=${encodeURIComponent(publisherDid)}`,
			{ method: "POST", headers, body: "{}", signal: options.signal },
			(value) => {
				if (!isRecord(value)) throw invalidResponse();
				return parseIntent(value["intent"], this.serviceUrl);
			},
		);
	}

	async waitForIntent(
		publisherDid: string,
		intentId: string,
		options: WaitForIntentOptions = {},
	): Promise<ReleaseIntentResource> {
		const pollIntervalMs = options.pollIntervalMs ?? 1_000;
		const maxWaitMs = options.maxWaitMs ?? 15 * 60_000;
		if (
			!Number.isSafeInteger(pollIntervalMs) ||
			pollIntervalMs < 0 ||
			!Number.isSafeInteger(maxWaitMs) ||
			maxWaitMs < 1
		) {
			throw new ReleaseServiceError({
				code: "INVALID_REQUEST",
				message: "Polling options are invalid",
			});
		}
		const deadline = Date.now() + maxWaitMs;
		for (;;) {
			const intent = await this.getIntent(publisherDid, intentId, { signal: options.signal });
			await options.onUpdate?.(intent);
			if (
				TERMINAL_RELEASE_INTENT_STATES.has(intent.state) ||
				((options.stopOnApproval ?? true) && intent.state === "awaiting_approval")
			) {
				return intent;
			}
			if (Date.now() >= deadline) {
				throw new ReleaseServiceError({
					code: "POLL_TIMEOUT",
					message: "Timed out waiting for release intent",
				});
			}
			await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())), options.signal);
		}
	}

	async getPublisher(options: RequestOptions = {}): Promise<PublisherResource> {
		return await this.call(
			"/v1/publisher",
			{ method: "GET", credentials: "include", signal: options.signal },
			(value) => {
				if (!isRecord(value)) throw invalidResponse();
				return parsePublisher(value["publisher"]);
			},
		);
	}

	async revokeDelegation(options: MutationOptions): Promise<PublisherResource> {
		return await this.call(
			"/v1/publisher/delegation",
			{
				method: "DELETE",
				credentials: "include",
				headers: await this.#publisherMutationHeaders(options.idempotencyKey),
				body: "{}",
				signal: options.signal,
			},
			(value) => {
				if (!isRecord(value)) throw invalidResponse();
				return parsePublisher(value["publisher"]);
			},
		);
	}

	async listWorkloads(
		options: RequestOptions & { cursor?: string; limit?: number } = {},
	): Promise<CursorPage<WorkloadPolicyResource>> {
		const url = new URL("/v1/publisher/workloads", this.serviceUrl);
		if (options.cursor) url.searchParams.set("cursor", options.cursor);
		if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
		return await this.call(
			`${url.pathname}${url.search}`,
			{ method: "GET", credentials: "include", signal: options.signal },
			(value) => parsePage(value, parsePolicy),
		);
	}

	async putWorkload(
		input: PutWorkloadPolicyInput,
		options: MutationOptions,
	): Promise<MutationResult<WorkloadPolicyResource>> {
		return await this.call(
			"/v1/publisher/workloads",
			{
				method: "POST",
				credentials: "include",
				headers: await this.#publisherMutationHeaders(options.idempotencyKey),
				body: JSON.stringify(input),
				signal: options.signal,
			},
			(value) => {
				if (!isRecord(value) || typeof value["replayed"] !== "boolean") {
					throw invalidResponse();
				}
				return { value: parsePolicy(value["policy"]), replayed: value["replayed"] };
			},
		);
	}

	async disableWorkload(
		packageSlug: string,
		expectedVersion: number,
		options: MutationOptions,
	): Promise<MutationResult<WorkloadPolicyResource>> {
		return await this.call(
			`/v1/publisher/workloads/${encodeURIComponent(packageSlug)}`,
			{
				method: "DELETE",
				credentials: "include",
				headers: await this.#publisherMutationHeaders(options.idempotencyKey),
				body: JSON.stringify({ expectedVersion }),
				signal: options.signal,
			},
			(value) => {
				if (!isRecord(value) || typeof value["replayed"] !== "boolean") {
					throw invalidResponse();
				}
				return { value: parsePolicy(value["policy"]), replayed: value["replayed"] };
			},
		);
	}

	async listPublisherIntents(
		options: RequestOptions & { cursor?: string; limit?: number } = {},
	): Promise<CursorPage<ReleaseIntentResource>> {
		const url = new URL("/v1/publisher/intents", this.serviceUrl);
		if (options.cursor) url.searchParams.set("cursor", options.cursor);
		if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
		return await this.call(
			`${url.pathname}${url.search}`,
			{ method: "GET", credentials: "include", signal: options.signal },
			(value) => parsePage(value, (item) => parseIntent(item, this.serviceUrl)),
		);
	}
}

function parsePage<T>(value: unknown, parseItem: (item: unknown) => T): CursorPage<T> {
	if (!isRecord(value) || !Array.isArray(value["items"])) throw invalidResponse();
	const nextCursor = value["nextCursor"];
	if (nextCursor !== undefined && typeof nextCursor !== "string") throw invalidResponse();
	return {
		items: value["items"].map(parseItem),
		...(nextCursor ? { nextCursor } : {}),
	};
}

export class ReleaseServiceOperatorClient extends BaseReleaseServiceClient {
	#mutationHeaders(idempotencyKey: string): Headers {
		return new Headers({
			"content-type": "application/json",
			"idempotency-key": requireIdempotencyKey(idempotencyKey),
			"x-emdash-request": "1",
		});
	}

	async getStatus(options: RequestOptions = {}): Promise<ServiceControlState> {
		return await this.call(
			"/admin/api/status",
			{ method: "GET", credentials: "include", signal: options.signal },
			(value) => {
				if (!isRecord(value)) throw invalidResponse();
				return parseServiceState(value["state"]);
			},
		);
	}

	async setMode(
		mode: ServiceControlState["mode"],
		reasonCode: string | null,
		options: MutationOptions,
	): Promise<MutationResult<ServiceControlState>> {
		return await this.call(
			"/admin/api/pause",
			{
				method: "POST",
				credentials: "include",
				headers: this.#mutationHeaders(options.idempotencyKey),
				body: JSON.stringify({ mode, reasonCode }),
				signal: options.signal,
			},
			(value) => {
				if (!isRecord(value) || typeof value["replayed"] !== "boolean") {
					throw invalidResponse();
				}
				return { value: parseServiceState(value["state"]), replayed: value["replayed"] };
			},
		);
	}

	async getPublisher(
		publisherDid: string,
		options: RequestOptions = {},
	): Promise<OperatorPublisherResource> {
		return await this.call(
			`/admin/api/publishers/${encodeURIComponent(publisherDid)}`,
			{ method: "GET", credentials: "include", signal: options.signal },
			(value) => {
				if (!isRecord(value) || !isRecord(value["publisher"])) throw invalidResponse();
				const publisher = parsePublisher(value["publisher"]);
				return { ...publisher, control: parsePublisherControl(value["publisher"]["control"]) };
			},
		);
	}

	async setPublisherSuspended(
		publisherDid: string,
		suspended: boolean,
		reasonCode: string | null,
		options: MutationOptions,
	): Promise<PublisherControlResource> {
		return await this.call(
			`/admin/api/publishers/${encodeURIComponent(publisherDid)}/suspend`,
			{
				method: "POST",
				credentials: "include",
				headers: this.#mutationHeaders(options.idempotencyKey),
				body: JSON.stringify({ suspended, reasonCode }),
				signal: options.signal,
			},
			(value) => {
				if (!isRecord(value) || !isRecord(value["publisher"])) throw invalidResponse();
				return parsePublisherControl(value["publisher"]["control"]);
			},
		);
	}

	async revokePublisher(
		publisherDid: string,
		options: MutationOptions,
	): Promise<PublisherResource> {
		return await this.call(
			`/admin/api/publishers/${encodeURIComponent(publisherDid)}/revoke`,
			{
				method: "POST",
				credentials: "include",
				headers: this.#mutationHeaders(options.idempotencyKey),
				body: "{}",
				signal: options.signal,
			},
			(value) => {
				if (!isRecord(value)) throw invalidResponse();
				return parsePublisher(value["publisher"]);
			},
		);
	}

	async cancelIntent(
		publisherDid: string,
		intentId: string,
		options: MutationOptions,
	): Promise<ReleaseIntentResource> {
		return await this.call(
			`/admin/api/intents/${encodeURIComponent(intentId)}/cancel`,
			{
				method: "POST",
				credentials: "include",
				headers: this.#mutationHeaders(options.idempotencyKey),
				body: JSON.stringify({ publisherDid }),
				signal: options.signal,
			},
			(value) => {
				if (!isRecord(value)) throw invalidResponse();
				return parseIntent(value["intent"], this.serviceUrl);
			},
		);
	}

	async reconcileIntent(
		publisherDid: string,
		intentId: string,
		options: MutationOptions,
	): Promise<{ intent: ReleaseIntentResource; restarted: boolean }> {
		return await this.call(
			`/admin/api/intents/${encodeURIComponent(intentId)}/reconcile`,
			{
				method: "POST",
				credentials: "include",
				headers: this.#mutationHeaders(options.idempotencyKey),
				body: JSON.stringify({ publisherDid }),
				signal: options.signal,
			},
			(value) => {
				if (!isRecord(value) || typeof value["restarted"] !== "boolean") {
					throw invalidResponse();
				}
				return {
					intent: parseIntent(value["intent"], this.serviceUrl),
					restarted: value["restarted"],
				};
			},
		);
	}
}

export type ReleaseRecord = PackageRelease.Main;
