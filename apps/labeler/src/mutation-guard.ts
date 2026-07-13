import { ulid } from "ulidx";

import {
	AccessAuthError,
	hasRole,
	verifyAccessRequest,
	type AccessAuthConfig,
	type AccessKeyResolver,
	type OperatorIdentity,
	type OperatorRole,
} from "./access-auth.js";
import {
	buildOperatorActionInsert,
	computeRequestFingerprint,
	getOperatorActionByKey,
	isIdempotencyKeyConflict,
	type OperatorActionType,
} from "./operator-actions.js";

export { type OperatorActionType } from "./operator-actions.js";

/** Custom header (reusing emdash-core's convention) whose presence proves a
 * non-simple request the browser could only send same-origin. Value must be "1". */
export const OPERATOR_REQUEST_HEADER = "X-EmDash-Request";

const REASON_MAX_LENGTH = 1_000;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/;
const QUOTED_VALUE = /^"(.*)"$/;

export type MutationGuardCode =
	| "UNSUPPORTED_MEDIA_TYPE"
	| "CROSS_ORIGIN"
	| "CSRF_HEADER_MISSING"
	| "UNAUTHENTICATED"
	| "FORBIDDEN_ROLE"
	| "INVALID_BODY"
	| "IDEMPOTENCY_KEY_CONFLICT";

const GUARD_ERROR: Readonly<Record<MutationGuardCode, { status: number; message: string }>> = {
	UNSUPPORTED_MEDIA_TYPE: { status: 415, message: "Request must be application/json" },
	CROSS_ORIGIN: { status: 403, message: "Cross-origin request rejected" },
	CSRF_HEADER_MISSING: { status: 403, message: "Missing required request header" },
	UNAUTHENTICATED: { status: 401, message: "Operator authentication required" },
	FORBIDDEN_ROLE: { status: 403, message: "Insufficient role for this action" },
	INVALID_BODY: { status: 400, message: "Request body is invalid" },
	IDEMPOTENCY_KEY_CONFLICT: {
		status: 409,
		message: "Idempotency key already used for a different request",
	},
};

/**
 * Guard rejection. Messages are static per code — they never echo the token,
 * request body, or header values, so `toResponse` cannot leak attacker- or
 * operator-supplied content.
 */
export class MutationGuardError extends Error {
	override readonly name = "MutationGuardError";
	readonly code: MutationGuardCode;
	readonly status: number;

	constructor(code: MutationGuardCode) {
		const { status, message } = GUARD_ERROR[code];
		super(message);
		this.code = code;
		this.status = status;
	}

	toResponse(): Response {
		// Same wire shape as core's apiError: { error: { code, message } }.
		return Response.json(
			{ error: { code: this.code, message: this.message } },
			{ status: this.status },
		);
	}
}

export interface MutationGuardDeps {
	db: D1Database;
	config: AccessAuthConfig;
	keys: AccessKeyResolver;
	now: () => Date;
	/** Defaults to the request URL's origin; override for proxy edge cases. */
	expectedOrigin?: string;
}

export interface MutationSpec<TBody> {
	action: OperatorActionType;
	requiredRole: OperatorRole;
	/** Validates and normalizes endpoint fields; throws
	 * `MutationGuardError("INVALID_BODY")` on bad input. `reason` and
	 * `idempotencyKey` are validated by the guard, not here. */
	parseBody: (raw: Record<string, unknown>) => TBody;
	auditFields: (body: TBody) => {
		subjectUri?: string;
		subjectCid?: string;
		labelValue?: string;
		metadata?: Record<string, unknown>;
	};
}

export interface MutationContext<TBody> {
	identity: OperatorIdentity;
	/** The role the actor actually held to satisfy the requirement: `requiredRole`
	 * when held directly, otherwise `admin` via inheritance. */
	role: OperatorRole;
	body: TBody;
	reason: string;
	idempotencyKey: string;
	fingerprint: string;
	/** Pre-minted; becomes `operator_actions.id` and the `operatorTriggerId` anchor. */
	actionId: string;
	now: Date;
}

export type MutationOutcome<TBody> =
	| { outcome: "proceed"; ctx: MutationContext<TBody> }
	/** Prior action found; the route returns `result` as-is. Carries only the
	 * stored result and its id — never the audit record's `reason` or fingerprint. */
	| { outcome: "replay"; result: unknown; actionId: string };

/**
 * The seven mutation protections (spec §12), run in a fail-fast order that
 * puts cheap transport/CSRF checks before signature verification: content
 * type, same-origin, CSRF header, freshly verified Access identity, role,
 * body/reason/idempotency-key validation, then the idempotency lookup. A
 * matching prior action short-circuits to `replay`; otherwise the caller runs
 * its effect and commits through `commitMutation`.
 */
export async function guardMutation<TBody>(
	request: Request,
	spec: MutationSpec<TBody>,
	deps: MutationGuardDeps,
): Promise<MutationOutcome<TBody>> {
	assertJsonContentType(request);
	assertSameOrigin(request, deps.expectedOrigin ?? new URL(request.url).origin);
	assertCsrfHeader(request);

	let identity: OperatorIdentity;
	try {
		identity = await verifyAccessRequest(request, deps.config, deps.keys);
	} catch (error) {
		if (error instanceof AccessAuthError) throw new MutationGuardError("UNAUTHENTICATED");
		throw error;
	}

	if (!hasRole(identity, spec.requiredRole)) throw new MutationGuardError("FORBIDDEN_ROLE");
	// The role the actor actually held to pass the check, for the audit row: the
	// requirement when held directly, otherwise `admin` — inheritance (admin
	// satisfying a reviewer gate) is the only other way `hasRole` returns true.
	const authorizedRole: OperatorRole = identity.roles.includes(spec.requiredRole)
		? spec.requiredRole
		: "admin";

	const raw = await parseJsonBody(request);
	const reason = validateReason(raw.reason);
	const idempotencyKey = validateIdempotencyKey(raw.idempotencyKey);
	const body = spec.parseBody(raw);

	const fingerprint = await computeRequestFingerprint(
		spec.action,
		isRecord(body) ? { ...body, reason } : { reason },
	);
	const existing = await getOperatorActionByKey(deps.db, idempotencyKey);
	if (existing) {
		if (existing.requestFingerprint !== fingerprint)
			throw new MutationGuardError("IDEMPOTENCY_KEY_CONFLICT");
		return {
			outcome: "replay",
			result: existing.resultJson === null ? null : JSON.parse(existing.resultJson),
			actionId: existing.id,
		};
	}

	return {
		outcome: "proceed",
		ctx: {
			identity,
			role: authorizedRole,
			body,
			reason,
			idempotencyKey,
			fingerprint,
			actionId: `oact_${ulid()}`,
			now: deps.now(),
		},
	};
}

/**
 * Atomically commits the audit row and its effect in a single `db.batch`. The
 * audit insert is a plain INSERT, so a duplicate `idempotency_key` raises a
 * UNIQUE violation that aborts the whole batch — the effect statements roll back
 * with it, meaning a request that loses the key race can never commit a side
 * effect (regardless of whether the effect is itself idempotent). On that
 * conflict we read the winning row back: a matching fingerprint means an
 * identical request already committed, so we return its stored result (replay);
 * a differing fingerprint is genuine key reuse → `IDEMPOTENCY_KEY_CONFLICT`.
 * This is the only sanctioned commit path, so an effect can never land without
 * its audit row.
 */
export async function commitMutation<TBody, TResult>(
	db: D1Database,
	ctx: MutationContext<TBody>,
	spec: MutationSpec<TBody>,
	effect: readonly D1PreparedStatement[],
	result: TResult,
): Promise<TResult> {
	const audit = spec.auditFields(ctx.body);
	const insert = buildOperatorActionInsert(db, {
		id: ctx.actionId,
		actorType: ctx.identity.kind,
		actorId: ctx.identity.sub,
		actorEmail: ctx.identity.kind === "human" ? ctx.identity.email : null,
		actorCommonName: ctx.identity.kind === "service" ? ctx.identity.commonName : null,
		role: ctx.role,
		action: spec.action,
		subjectUri: audit.subjectUri ?? null,
		subjectCid: audit.subjectCid ?? null,
		labelValue: audit.labelValue ?? null,
		reason: ctx.reason,
		idempotencyKey: ctx.idempotencyKey,
		requestFingerprint: ctx.fingerprint,
		resultJson: JSON.stringify(result),
		metadataJson: JSON.stringify(audit.metadata ?? {}),
		createdAt: ctx.now.toISOString(),
		createdAtEpochMs: ctx.now.getTime(),
	});

	try {
		await db.batch([insert, ...effect]);
	} catch (error) {
		if (!isIdempotencyKeyConflict(error)) throw error;
		// Our audit insert hit the unique key, so the batch — including our effect
		// — rolled back. A concurrent or prior request with this key won; read it
		// back to replay its result or report a genuine content conflict.
		const stored = await getOperatorActionByKey(db, ctx.idempotencyKey);
		if (!stored) throw error;
		if (stored.requestFingerprint !== ctx.fingerprint)
			throw new MutationGuardError("IDEMPOTENCY_KEY_CONFLICT");
		if (stored.resultJson === null) return result;
		const winnerResult: TResult = JSON.parse(stored.resultJson);
		return winnerResult;
	}

	return result;
}

function assertJsonContentType(request: Request): void {
	const header = request.headers.get("Content-Type");
	if (header === null) throw new MutationGuardError("UNSUPPORTED_MEDIA_TYPE");
	const [rawMedia, ...params] = header.split(";");
	if ((rawMedia ?? "").trim().toLowerCase() !== "application/json")
		throw new MutationGuardError("UNSUPPORTED_MEDIA_TYPE");
	for (const param of params) {
		const eq = param.indexOf("=");
		if (eq === -1) continue;
		if (param.slice(0, eq).trim().toLowerCase() !== "charset") continue;
		const charset = param
			.slice(eq + 1)
			.trim()
			.toLowerCase()
			.replace(QUOTED_VALUE, "$1");
		if (charset !== "utf-8") throw new MutationGuardError("UNSUPPORTED_MEDIA_TYPE");
	}
}

function assertSameOrigin(request: Request, expectedOrigin: string): void {
	const origin = request.headers.get("Origin");
	if (origin !== null && origin !== expectedOrigin) throw new MutationGuardError("CROSS_ORIGIN");
	const site = request.headers.get("Sec-Fetch-Site");
	if (site !== null && site !== "same-origin") throw new MutationGuardError("CROSS_ORIGIN");
}

function assertCsrfHeader(request: Request): void {
	if (request.headers.get(OPERATOR_REQUEST_HEADER) !== "1")
		throw new MutationGuardError("CSRF_HEADER_MISSING");
}

async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
	let parsed: unknown;
	try {
		parsed = await request.json();
	} catch {
		throw new MutationGuardError("INVALID_BODY");
	}
	if (!isRecord(parsed) || Array.isArray(parsed)) throw new MutationGuardError("INVALID_BODY");
	return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function validateReason(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > REASON_MAX_LENGTH)
		throw new MutationGuardError("INVALID_BODY");
	return value;
}

function validateIdempotencyKey(value: unknown): string {
	if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value))
		throw new MutationGuardError("INVALID_BODY");
	return value;
}
