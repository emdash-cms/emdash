import { DurableObject } from "cloudflare:workers";
import { base64url } from "jose";

import type { AccessActor, AccessRole } from "../access/auth.js";

export const SERVICE_CONTROL_OBJECT_NAME = "global";

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const ACTOR_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const INTENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PERMIT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const PERMIT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_PERMIT_TTL_MS = 30_000;
const OPERATOR_IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const ROLE_RANK: Readonly<Record<AccessRole, number>> = {
	viewer: 1,
	reviewer: 2,
	admin: 3,
};

export type ServiceMode = "active" | "admission-paused" | "publication-paused";
export type PublisherControlStatus = "allowed" | "suspended";

export type ServiceControlErrorCode =
	| "CONTROL_ACTOR_INVALID"
	| "CONTROL_INPUT_INVALID"
	| "CONTROL_OBJECT_MISMATCH"
	| "CONTROL_STATE_CORRUPT";

export class ServiceControlError extends Error {
	readonly code: ServiceControlErrorCode;

	constructor(code: ServiceControlErrorCode) {
		super(code);
		this.name = "ServiceControlError";
		this.code = code;
	}
}

export interface ServiceState {
	mode: ServiceMode;
	epoch: number;
	reasonCode: string | null;
	changedBy: string;
	changedAt: number;
}

export interface PublisherControl {
	publisherDid: string;
	status: PublisherControlStatus;
	reasonCode: string | null;
	changedBy: string;
	changedAt: number;
}

interface OperatorMutationInput {
	actor: AccessActor;
	idempotencyKey: string;
	requestDigest: string;
	now?: number;
}

export interface SetServiceModeInput extends OperatorMutationInput {
	mode: ServiceMode;
	reasonCode: string | null;
}

export interface SetPublisherControlInput extends OperatorMutationInput {
	publisherDid: string;
	status: PublisherControlStatus;
	reasonCode: string | null;
}

export type OperatorMutationResult<T> =
	| { ok: true; value: T; replayed: boolean }
	| { ok: false; code: "IDEMPOTENCY_CONFLICT" };

export interface AdmissionDecision {
	allowed: boolean;
	mode: ServiceMode;
	modeEpoch: number;
	code: "ADMISSION_PAUSED" | "PUBLISHER_SUSPENDED" | null;
}

export interface PublicationPermit {
	id: string;
	token: string;
	publisherDid: string;
	intentId: string;
	modeEpoch: number;
	expiresAt: number;
}

export type IssuePublicationPermitResult =
	| { ok: true; permit: PublicationPermit }
	| { ok: false; code: "PUBLICATION_PAUSED" | "PUBLISHER_SUSPENDED" };

export interface ConsumePublicationPermitInput {
	id: string;
	token: string;
	publisherDid: string;
	intentId: string;
	now?: number;
}

export type ConsumePublicationPermitResult =
	| { ok: true; modeEpoch: number }
	| {
			ok: false;
			code:
				| "PERMIT_NOT_FOUND"
				| "PERMIT_INVALID"
				| "PERMIT_CONSUMED"
				| "PERMIT_EXPIRED"
				| "PERMIT_STALE"
				| "PUBLICATION_PAUSED"
				| "PUBLISHER_SUSPENDED";
	  };

export interface ControlAuditEvent {
	sequence: number;
	eventType: string;
	actorRealm: "access" | "system";
	actorIdentity: string;
	actorRole: AccessRole | null;
	subject: string;
	reasonCode: string | null;
	createdAt: number;
}

interface ServiceStateRow {
	[key: string]: string | number | ArrayBuffer | null;
	mode: ServiceMode;
	epoch: number;
	reason_code: string | null;
	operator_identity: string;
	changed_at: number;
}

interface PublisherControlRow {
	[key: string]: string | number | ArrayBuffer | null;
	publisher_did: string;
	status: PublisherControlStatus;
	reason_code: string | null;
	operator_identity: string;
	changed_at: number;
}

interface IdempotencyRow {
	[key: string]: string | number | ArrayBuffer | null;
	action: string;
	request_digest: string;
	result_json: string;
	expires_at: number;
}

interface PublicationPermitRow {
	[key: string]: string | number | ArrayBuffer | null;
	token_hash: string;
	publisher_did: string;
	intent_id: string;
	mode_epoch: number;
	expires_at: number;
	consumed_at: number | null;
}

interface AuditRow {
	[key: string]: string | number | ArrayBuffer | null;
	sequence: number;
	event_type: string;
	actor_realm: "access" | "system";
	actor_identity: string;
	actor_role: AccessRole | null;
	subject: string;
	reason_code: string | null;
	created_at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validReasonCode(value: unknown): value is string | null {
	return value === null || (typeof value === "string" && REASON_CODE_PATTERN.test(value));
}

function validTimestamp(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseServiceState(value: string): ServiceState {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new ServiceControlError("CONTROL_STATE_CORRUPT");
	}
	if (
		!isRecord(parsed) ||
		(parsed["mode"] !== "active" &&
			parsed["mode"] !== "admission-paused" &&
			parsed["mode"] !== "publication-paused") ||
		!Number.isSafeInteger(parsed["epoch"]) ||
		Number(parsed["epoch"]) < 1 ||
		!validReasonCode(parsed["reasonCode"]) ||
		typeof parsed["changedBy"] !== "string" ||
		!ACTOR_IDENTITY_PATTERN.test(parsed["changedBy"]) ||
		!validTimestamp(parsed["changedAt"])
	) {
		throw new ServiceControlError("CONTROL_STATE_CORRUPT");
	}
	return {
		mode: parsed["mode"],
		epoch: Number(parsed["epoch"]),
		reasonCode: parsed["reasonCode"],
		changedBy: parsed["changedBy"],
		changedAt: parsed["changedAt"],
	};
}

function parsePublisherControl(value: string): PublisherControl {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new ServiceControlError("CONTROL_STATE_CORRUPT");
	}
	if (
		!isRecord(parsed) ||
		typeof parsed["publisherDid"] !== "string" ||
		!DID_PATTERN.test(parsed["publisherDid"]) ||
		(parsed["status"] !== "allowed" && parsed["status"] !== "suspended") ||
		!validReasonCode(parsed["reasonCode"]) ||
		typeof parsed["changedBy"] !== "string" ||
		!ACTOR_IDENTITY_PATTERN.test(parsed["changedBy"]) ||
		!validTimestamp(parsed["changedAt"])
	) {
		throw new ServiceControlError("CONTROL_STATE_CORRUPT");
	}
	return {
		publisherDid: parsed["publisherDid"],
		status: parsed["status"],
		reasonCode: parsed["reasonCode"],
		changedBy: parsed["changedBy"],
		changedAt: parsed["changedAt"],
	};
}

async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return base64url.encode(new Uint8Array(digest));
}

function hashesEqual(left: string, right: string): boolean {
	try {
		const leftBytes = base64url.decode(left);
		const rightBytes = base64url.decode(right);
		return (
			leftBytes.length === rightBytes.length && crypto.subtle.timingSafeEqual(leftBytes, rightBytes)
		);
	} catch {
		return false;
	}
}

export class ServiceControlDurableObject extends DurableObject<Env> {
	readonly #objectName: string | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.#objectName = ctx.id.name;
		void ctx.blockConcurrencyWhile(async () => {
			this.#initializeSchema();
		});
	}

	#initializeSchema(): void {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS service_state (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				mode TEXT NOT NULL CHECK (mode IN ('active', 'admission-paused', 'publication-paused')),
				epoch INTEGER NOT NULL CHECK (epoch >= 1),
				reason_code TEXT,
				operator_identity TEXT NOT NULL,
				changed_at INTEGER NOT NULL
			);
			INSERT OR IGNORE INTO service_state (
				id, mode, epoch, reason_code, operator_identity, changed_at
			) VALUES (1, 'active', 1, NULL, 'system:bootstrap', 0);
			CREATE TABLE IF NOT EXISTS encryption_keys (
				version INTEGER PRIMARY KEY CHECK (version >= 1),
				status TEXT NOT NULL CHECK (status IN ('active', 'readable', 'retired')),
				activated_at INTEGER,
				retired_at INTEGER,
				operator_identity TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE UNIQUE INDEX IF NOT EXISTS idx_encryption_keys_active
				ON encryption_keys(status) WHERE status = 'active';
			CREATE TABLE IF NOT EXISTS publisher_controls (
				publisher_did TEXT PRIMARY KEY,
				status TEXT NOT NULL CHECK (status IN ('allowed', 'suspended')),
				reason_code TEXT,
				operator_identity TEXT NOT NULL,
				changed_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS operator_idempotency (
				operator_identity TEXT NOT NULL,
				mutation_key TEXT NOT NULL,
				action TEXT NOT NULL,
				request_digest TEXT NOT NULL,
				result_json TEXT NOT NULL,
				expires_at INTEGER NOT NULL,
				PRIMARY KEY (operator_identity, mutation_key)
			);
			CREATE INDEX IF NOT EXISTS idx_operator_idempotency_expiry
				ON operator_idempotency(expires_at);
			CREATE TABLE IF NOT EXISTS publication_permits (
				id TEXT PRIMARY KEY,
				token_hash TEXT NOT NULL,
				publisher_did TEXT NOT NULL,
				intent_id TEXT NOT NULL,
				mode_epoch INTEGER NOT NULL CHECK (mode_epoch >= 1),
				expires_at INTEGER NOT NULL,
				consumed_at INTEGER,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_publication_permits_expiry
				ON publication_permits(expires_at);
			CREATE TABLE IF NOT EXISTS audit_events (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				event_type TEXT NOT NULL,
				actor_realm TEXT NOT NULL CHECK (actor_realm IN ('access', 'system')),
				actor_identity TEXT NOT NULL,
				actor_role TEXT CHECK (actor_role IN ('viewer', 'reviewer', 'admin')),
				subject TEXT NOT NULL,
				reason_code TEXT,
				public_payload TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
		`);
	}

	#assertObjectName(): void {
		if (this.#objectName !== SERVICE_CONTROL_OBJECT_NAME) {
			throw new ServiceControlError("CONTROL_OBJECT_MISMATCH");
		}
	}

	#assertActor(actor: AccessActor, minimumRole: AccessRole): void {
		if (
			!isRecord(actor) ||
			actor.realm !== "access" ||
			typeof actor.identity !== "string" ||
			!ACTOR_IDENTITY_PATTERN.test(actor.identity) ||
			(actor.role !== "viewer" && actor.role !== "reviewer" && actor.role !== "admin") ||
			ROLE_RANK[actor.role] < ROLE_RANK[minimumRole]
		) {
			throw new ServiceControlError("CONTROL_ACTOR_INVALID");
		}
	}

	#assertOperatorMutation(input: OperatorMutationInput): number {
		this.#assertActor(input.actor, "admin");
		const now = input.now ?? Date.now();
		if (
			!IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey) ||
			!DIGEST_PATTERN.test(input.requestDigest) ||
			!validTimestamp(now) ||
			now > Number.MAX_SAFE_INTEGER - OPERATOR_IDEMPOTENCY_TTL_MS
		) {
			throw new ServiceControlError("CONTROL_INPUT_INVALID");
		}
		return now;
	}

	#readState(): ServiceState {
		const row = this.ctx.storage.sql
			.exec<ServiceStateRow>(
				`SELECT mode, epoch, reason_code, operator_identity, changed_at
				 FROM service_state WHERE id = 1`,
			)
			.one();
		return {
			mode: row.mode,
			epoch: row.epoch,
			reasonCode: row.reason_code,
			changedBy: row.operator_identity,
			changedAt: row.changed_at,
		};
	}

	#readPublisherControl(publisherDid: string): PublisherControl {
		const row = this.ctx.storage.sql
			.exec<PublisherControlRow>(
				`SELECT publisher_did, status, reason_code, operator_identity, changed_at
				 FROM publisher_controls WHERE publisher_did = ?`,
				publisherDid,
			)
			.toArray()[0];
		return row
			? {
					publisherDid: row.publisher_did,
					status: row.status,
					reasonCode: row.reason_code,
					changedBy: row.operator_identity,
					changedAt: row.changed_at,
				}
			: {
					publisherDid,
					status: "allowed",
					reasonCode: null,
					changedBy: "system:default",
					changedAt: 0,
				};
	}

	#readIdempotency(actorIdentity: string, mutationKey: string, now: number): IdempotencyRow | null {
		const row = this.ctx.storage.sql
			.exec<IdempotencyRow>(
				`SELECT action, request_digest, result_json, expires_at
					 FROM operator_idempotency
					 WHERE operator_identity = ? AND mutation_key = ?`,
				actorIdentity,
				mutationKey,
			)
			.toArray()[0];
		if (!row) return null;
		if (row.expires_at > now) return row;
		this.ctx.storage.sql.exec(
			"DELETE FROM operator_idempotency WHERE operator_identity = ? AND mutation_key = ?",
			actorIdentity,
			mutationKey,
		);
		return null;
	}

	#writeIdempotency(
		input: OperatorMutationInput,
		action: string,
		result: ServiceState | PublisherControl,
		now: number,
	): void {
		this.ctx.storage.sql.exec(
			`INSERT INTO operator_idempotency (
				operator_identity, mutation_key, action, request_digest, result_json, expires_at
			) VALUES (?, ?, ?, ?, ?, ?)`,
			input.actor.identity,
			input.idempotencyKey,
			action,
			input.requestDigest,
			JSON.stringify(result),
			now + OPERATOR_IDEMPOTENCY_TTL_MS,
		);
	}

	#appendAudit(
		eventType: string,
		actorRealm: "access" | "system",
		actorIdentity: string,
		actorRole: AccessRole | null,
		subject: string,
		reasonCode: string | null,
		createdAt: number,
	): void {
		this.ctx.storage.sql.exec(
			`INSERT INTO audit_events (
				event_type, actor_realm, actor_identity, actor_role, subject,
				reason_code, public_payload, created_at
			) VALUES (?, ?, ?, ?, ?, ?, '{}', ?)`,
			eventType,
			actorRealm,
			actorIdentity,
			actorRole,
			subject,
			reasonCode,
			createdAt,
		);
	}

	async #scheduleCleanup(now: number): Promise<void> {
		const row = this.ctx.storage.sql
			.exec<{ next_expiry: number | null }>(
				`SELECT MIN(expires_at) AS next_expiry FROM (
					SELECT expires_at FROM operator_idempotency
					UNION ALL
					SELECT expires_at FROM publication_permits
				)`,
			)
			.one();
		if (row.next_expiry === null) {
			await this.ctx.storage.deleteAlarm();
			return;
		}
		await this.ctx.storage.setAlarm(Math.max(now + 1, row.next_expiry));
	}

	async readServiceState(actor: AccessActor): Promise<ServiceState> {
		this.#assertObjectName();
		this.#assertActor(actor, "viewer");
		return this.#readState();
	}

	async checkReadiness(): Promise<void> {
		this.#assertObjectName();
		this.#readState();
	}

	async setServiceMode(input: SetServiceModeInput): Promise<OperatorMutationResult<ServiceState>> {
		this.#assertObjectName();
		const now = this.#assertOperatorMutation(input);
		if (
			(input.mode !== "active" &&
				input.mode !== "admission-paused" &&
				input.mode !== "publication-paused") ||
			!validReasonCode(input.reasonCode) ||
			(input.mode === "active") !== (input.reasonCode === null)
		) {
			throw new ServiceControlError("CONTROL_INPUT_INVALID");
		}
		const result = this.ctx.storage.transactionSync(() => {
			const existing = this.#readIdempotency(input.actor.identity, input.idempotencyKey, now);
			if (existing) {
				if (existing.action !== "service-mode" || existing.request_digest !== input.requestDigest) {
					return { ok: false, code: "IDEMPOTENCY_CONFLICT" } as const;
				}
				return {
					ok: true,
					value: parseServiceState(existing.result_json),
					replayed: true,
				} as const;
			}
			const current = this.#readState();
			let next = current;
			if (current.mode !== input.mode || current.reasonCode !== input.reasonCode) {
				next = {
					mode: input.mode,
					epoch: current.epoch + 1,
					reasonCode: input.reasonCode,
					changedBy: input.actor.identity,
					changedAt: now,
				};
				this.ctx.storage.sql.exec(
					`UPDATE service_state SET
						mode = ?, epoch = ?, reason_code = ?, operator_identity = ?, changed_at = ?
					 WHERE id = 1`,
					next.mode,
					next.epoch,
					next.reasonCode,
					next.changedBy,
					next.changedAt,
				);
				this.#appendAudit(
					"service-mode-changed",
					"access",
					input.actor.identity,
					input.actor.role,
					input.mode,
					input.reasonCode,
					now,
				);
			}
			this.#writeIdempotency(input, "service-mode", next, now);
			return { ok: true, value: next, replayed: false } as const;
		});
		await this.#scheduleCleanup(now);
		return result;
	}

	async readPublisherControl(actor: AccessActor, publisherDid: string): Promise<PublisherControl> {
		this.#assertObjectName();
		this.#assertActor(actor, "viewer");
		if (!DID_PATTERN.test(publisherDid)) {
			throw new ServiceControlError("CONTROL_INPUT_INVALID");
		}
		return this.#readPublisherControl(publisherDid);
	}

	async setPublisherControl(
		input: SetPublisherControlInput,
	): Promise<OperatorMutationResult<PublisherControl>> {
		this.#assertObjectName();
		const now = this.#assertOperatorMutation(input);
		if (
			!DID_PATTERN.test(input.publisherDid) ||
			(input.status !== "allowed" && input.status !== "suspended") ||
			!validReasonCode(input.reasonCode) ||
			(input.status === "allowed") !== (input.reasonCode === null)
		) {
			throw new ServiceControlError("CONTROL_INPUT_INVALID");
		}
		const action = `publisher-control:${input.publisherDid}`;
		const result = this.ctx.storage.transactionSync(() => {
			const existing = this.#readIdempotency(input.actor.identity, input.idempotencyKey, now);
			if (existing) {
				if (existing.action !== action || existing.request_digest !== input.requestDigest) {
					return { ok: false, code: "IDEMPOTENCY_CONFLICT" } as const;
				}
				return {
					ok: true,
					value: parsePublisherControl(existing.result_json),
					replayed: true,
				} as const;
			}
			const current = this.#readPublisherControl(input.publisherDid);
			let next = current;
			if (current.status !== input.status || current.reasonCode !== input.reasonCode) {
				next = {
					publisherDid: input.publisherDid,
					status: input.status,
					reasonCode: input.reasonCode,
					changedBy: input.actor.identity,
					changedAt: now,
				};
				this.ctx.storage.sql.exec(
					`INSERT INTO publisher_controls (
						publisher_did, status, reason_code, operator_identity, changed_at
					) VALUES (?, ?, ?, ?, ?)
					ON CONFLICT(publisher_did) DO UPDATE SET
						status = excluded.status,
						reason_code = excluded.reason_code,
						operator_identity = excluded.operator_identity,
						changed_at = excluded.changed_at`,
					next.publisherDid,
					next.status,
					next.reasonCode,
					next.changedBy,
					next.changedAt,
				);
				this.#appendAudit(
					"publisher-control-changed",
					"access",
					input.actor.identity,
					input.actor.role,
					input.publisherDid,
					input.reasonCode,
					now,
				);
			}
			this.#writeIdempotency(input, action, next, now);
			return { ok: true, value: next, replayed: false } as const;
		});
		await this.#scheduleCleanup(now);
		return result;
	}

	async getAdmissionDecision(publisherDid: string): Promise<AdmissionDecision> {
		this.#assertObjectName();
		if (!DID_PATTERN.test(publisherDid)) {
			throw new ServiceControlError("CONTROL_INPUT_INVALID");
		}
		const state = this.#readState();
		const control = this.#readPublisherControl(publisherDid);
		if (control.status === "suspended") {
			return {
				allowed: false,
				mode: state.mode,
				modeEpoch: state.epoch,
				code: "PUBLISHER_SUSPENDED",
			};
		}
		return {
			allowed: state.mode !== "admission-paused",
			mode: state.mode,
			modeEpoch: state.epoch,
			code: state.mode === "admission-paused" ? "ADMISSION_PAUSED" : null,
		};
	}

	async issuePublicationPermit(
		publisherDid: string,
		intentId: string,
		ttlMs: number,
		now = Date.now(),
	): Promise<IssuePublicationPermitResult> {
		this.#assertObjectName();
		if (
			!DID_PATTERN.test(publisherDid) ||
			!INTENT_ID_PATTERN.test(intentId) ||
			!Number.isSafeInteger(ttlMs) ||
			ttlMs < 1 ||
			ttlMs > MAX_PERMIT_TTL_MS ||
			!validTimestamp(now) ||
			now > Number.MAX_SAFE_INTEGER - ttlMs
		) {
			throw new ServiceControlError("CONTROL_INPUT_INVALID");
		}
		const id = base64url.encode(crypto.getRandomValues(new Uint8Array(16)));
		const token = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
		const tokenHash = await hashToken(token);
		const result = this.ctx.storage.transactionSync(() => {
			const state = this.#readState();
			if (state.mode === "publication-paused") {
				return { ok: false, code: "PUBLICATION_PAUSED" } as const;
			}
			if (this.#readPublisherControl(publisherDid).status === "suspended") {
				return { ok: false, code: "PUBLISHER_SUSPENDED" } as const;
			}
			const expiresAt = now + ttlMs;
			this.ctx.storage.sql.exec(
				`INSERT INTO publication_permits (
					id, token_hash, publisher_did, intent_id, mode_epoch,
					expires_at, consumed_at, created_at
				) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
				id,
				tokenHash,
				publisherDid,
				intentId,
				state.epoch,
				expiresAt,
				now,
			);
			this.#appendAudit(
				"publication-permit-issued",
				"system",
				"release-service",
				null,
				`${publisherDid}:${intentId}`,
				null,
				now,
			);
			return {
				ok: true,
				permit: { id, token, publisherDid, intentId, modeEpoch: state.epoch, expiresAt },
			} as const;
		});
		if (result.ok) await this.#scheduleCleanup(now);
		return result;
	}

	async consumePublicationPermit(
		input: ConsumePublicationPermitInput,
	): Promise<ConsumePublicationPermitResult> {
		this.#assertObjectName();
		const now = input.now ?? Date.now();
		if (
			!PERMIT_ID_PATTERN.test(input.id) ||
			!PERMIT_TOKEN_PATTERN.test(input.token) ||
			!DID_PATTERN.test(input.publisherDid) ||
			!INTENT_ID_PATTERN.test(input.intentId) ||
			!validTimestamp(now)
		) {
			throw new ServiceControlError("CONTROL_INPUT_INVALID");
		}
		const tokenHash = await hashToken(input.token);
		return this.ctx.storage.transactionSync(() => {
			const permit = this.ctx.storage.sql
				.exec<PublicationPermitRow>(
					`SELECT token_hash, publisher_did, intent_id, mode_epoch, expires_at, consumed_at
					 FROM publication_permits WHERE id = ?`,
					input.id,
				)
				.toArray()[0];
			if (!permit) return { ok: false, code: "PERMIT_NOT_FOUND" } as const;
			if (
				permit.publisher_did !== input.publisherDid ||
				permit.intent_id !== input.intentId ||
				!hashesEqual(permit.token_hash, tokenHash)
			) {
				return { ok: false, code: "PERMIT_INVALID" } as const;
			}
			if (permit.consumed_at !== null) {
				return { ok: false, code: "PERMIT_CONSUMED" } as const;
			}
			if (permit.expires_at <= now) return { ok: false, code: "PERMIT_EXPIRED" } as const;
			const state = this.#readState();
			if (permit.mode_epoch !== state.epoch) {
				return { ok: false, code: "PERMIT_STALE" } as const;
			}
			if (state.mode === "publication-paused") {
				return { ok: false, code: "PUBLICATION_PAUSED" } as const;
			}
			if (this.#readPublisherControl(input.publisherDid).status === "suspended") {
				return { ok: false, code: "PUBLISHER_SUSPENDED" } as const;
			}
			this.ctx.storage.sql.exec(
				"UPDATE publication_permits SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL",
				now,
				input.id,
			);
			this.#appendAudit(
				"publication-permit-consumed",
				"system",
				"release-service",
				null,
				`${input.publisherDid}:${input.intentId}`,
				null,
				now,
			);
			return { ok: true, modeEpoch: state.epoch } as const;
		});
	}

	async listAudit(
		actor: AccessActor,
		afterSequence = 0,
		limit = 50,
	): Promise<readonly ControlAuditEvent[]> {
		this.#assertObjectName();
		this.#assertActor(actor, "viewer");
		if (
			!Number.isSafeInteger(afterSequence) ||
			afterSequence < 0 ||
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > 101
		) {
			throw new ServiceControlError("CONTROL_INPUT_INVALID");
		}
		return this.ctx.storage.sql
			.exec<AuditRow>(
				`SELECT sequence, event_type, actor_realm, actor_identity, actor_role,
				        subject, reason_code, created_at
				 FROM audit_events WHERE sequence > ? ORDER BY sequence LIMIT ?`,
				afterSequence,
				limit,
			)
			.toArray()
			.map((row) => ({
				sequence: row.sequence,
				eventType: row.event_type,
				actorRealm: row.actor_realm,
				actorIdentity: row.actor_identity,
				actorRole: row.actor_role,
				subject: row.subject,
				reasonCode: row.reason_code,
				createdAt: row.created_at,
			}));
	}

	override async alarm(): Promise<void> {
		const now = Date.now();
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec("DELETE FROM operator_idempotency WHERE expires_at <= ?", now);
			this.ctx.storage.sql.exec("DELETE FROM publication_permits WHERE expires_at <= ?", now);
		});
		await this.#scheduleCleanup(now);
	}
}
