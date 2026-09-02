import {
	refRuleMatches,
	type StoredWorkloadPolicy,
	workflowRefRuleMatches,
} from "./workload-policy.js";

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const PACKAGE_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/;
const REF_PATTERN = /^refs\/[A-Za-z0-9._/-]{1,507}$/;
const WORKFLOW_REF_PATTERN =
	/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_./-]+\.ya?ml@refs\/[A-Za-z0-9._/-]+$/;
const MAX_ACTIVE_REQUESTS = 10;
const MAX_REQUEST_LIFETIME_MS = 60 * 60_000;
const REQUEST_RETENTION_MS = 24 * 60 * 60_000;

export type WorkflowConnectionRequestState = "confirmed" | "expired" | "pending";
export type WorkflowConnectionRefScope = "current_ref" | "version_tags";

export interface WorkflowConnectionClaim {
	repository: string;
	repositoryId: string;
	repositoryOwner: string;
	repositoryOwnerId: string;
	repositoryVisibility: "internal" | "private" | "public";
	workflowRef: string;
	ref: string;
	environment: string | null;
}

export interface StoredWorkflowConnectionRequest {
	id: string;
	packageSlug: string;
	state: WorkflowConnectionRequestState;
	claim: WorkflowConnectionClaim;
	refScope: WorkflowConnectionRefScope | null;
	expectedPolicyVersion: number | null;
	expiresAt: number;
	createdAt: number;
	confirmedAt: number | null;
}

export interface CreateWorkflowConnectionRequestInput {
	publisherDid: string;
	requestId: string;
	mutationKey: string;
	connectionKey: string;
	packageSlug: string;
	claim: WorkflowConnectionClaim;
	expiresAt: number;
	now?: number;
}

export type CreateWorkflowConnectionRequestResult =
	| { ok: true; request: StoredWorkflowConnectionRequest; replayed: boolean }
	| { ok: false; code: "WORKFLOW_CONNECTION_CONFLICT" | "WORKFLOW_CONNECTION_LIMIT_REACHED" };

export type PrepareWorkflowConnectionConfirmationResult =
	| { ok: true; request: StoredWorkflowConnectionRequest; replayed: boolean }
	| {
			ok: false;
			code: "WORKFLOW_CONNECTION_EXPIRED" | "WORKFLOW_CONNECTION_NOT_FOUND";
	  };

interface WorkflowConnectionRequestRow {
	[key: string]: string | number | ArrayBuffer | null;
	id: string;
	mutation_key: string;
	connection_key: string;
	package_slug: string;
	claim_json: string;
	state: WorkflowConnectionRequestState;
	ref_scope: WorkflowConnectionRefScope | null;
	expected_policy_version: number | null;
	expires_at: number;
	created_at: number;
	confirmed_at: number | null;
}

export class WorkflowConnectionError extends Error {
	constructor() {
		super("WORKFLOW_CONNECTION_INVALID");
		this.name = "WorkflowConnectionError";
	}
}

function validEnvironment(value: unknown): value is string | null {
	if (value === null) return true;
	if (typeof value !== "string" || value.length === 0 || value.length > 255) return false;
	for (const character of value) {
		const codePoint = character.codePointAt(0)!;
		if (codePoint <= 31 || codePoint === 127) return false;
	}
	return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeClaim(value: unknown): WorkflowConnectionClaim | null {
	if (!isRecord(value)) return null;
	const keys = Object.keys(value);
	if (
		keys.length !== 8 ||
		!keys.every((key) =>
			[
				"repository",
				"repositoryId",
				"repositoryOwner",
				"repositoryOwnerId",
				"repositoryVisibility",
				"workflowRef",
				"ref",
				"environment",
			].includes(key),
		)
	) {
		return null;
	}
	const repository = value["repository"];
	const repositoryId = value["repositoryId"];
	const repositoryOwner = value["repositoryOwner"];
	const repositoryOwnerId = value["repositoryOwnerId"];
	const repositoryVisibility = value["repositoryVisibility"];
	const workflowRef = value["workflowRef"];
	const ref = value["ref"];
	const environment = value["environment"];
	if (
		typeof repository !== "string" ||
		!REPOSITORY_PATTERN.test(repository) ||
		repository !== repository.toLowerCase() ||
		typeof repositoryId !== "string" ||
		!DECIMAL_ID_PATTERN.test(repositoryId) ||
		typeof repositoryOwner !== "string" ||
		repositoryOwner.length === 0 ||
		repositoryOwner.length > 64 ||
		repositoryOwner !== repositoryOwner.toLowerCase() ||
		typeof repositoryOwnerId !== "string" ||
		!DECIMAL_ID_PATTERN.test(repositoryOwnerId) ||
		(repositoryVisibility !== "public" &&
			repositoryVisibility !== "private" &&
			repositoryVisibility !== "internal") ||
		typeof workflowRef !== "string" ||
		!WORKFLOW_REF_PATTERN.test(workflowRef) ||
		!workflowRef.toLowerCase().startsWith(`${repository}/.github/workflows/`) ||
		typeof ref !== "string" ||
		!REF_PATTERN.test(ref) ||
		!validEnvironment(environment)
	) {
		return null;
	}
	return {
		repository,
		repositoryId,
		repositoryOwner,
		repositoryOwnerId,
		repositoryVisibility,
		workflowRef,
		ref,
		environment,
	};
}

function rowToRequest(row: WorkflowConnectionRequestRow): StoredWorkflowConnectionRequest {
	let claim: WorkflowConnectionClaim | null = null;
	try {
		claim = normalizeClaim(JSON.parse(row.claim_json));
	} catch {
		claim = null;
	}
	if (!claim || JSON.stringify(claim) !== row.claim_json) throw new WorkflowConnectionError();
	if (
		(row.state === "pending" && (row.ref_scope !== null || row.confirmed_at !== null)) ||
		(row.state === "confirmed" && (row.ref_scope === null || row.confirmed_at === null))
	) {
		throw new WorkflowConnectionError();
	}
	return {
		id: row.id,
		packageSlug: row.package_slug,
		state: row.state,
		claim,
		refScope: row.ref_scope,
		expectedPolicyVersion: row.expected_policy_version,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
		confirmedAt: row.confirmed_at,
	};
}

export function initializeWorkflowConnectionSchema(storage: DurableObjectStorage): void {
	storage.sql.exec(`
		CREATE TABLE IF NOT EXISTS workflow_connection_requests (
			id TEXT PRIMARY KEY,
			mutation_key TEXT NOT NULL UNIQUE,
			connection_key TEXT NOT NULL,
			package_slug TEXT NOT NULL,
			claim_json TEXT NOT NULL,
			state TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'expired')),
			ref_scope TEXT CHECK (ref_scope IS NULL OR ref_scope IN ('current_ref', 'version_tags')),
			expected_policy_version INTEGER,
			expires_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			confirmed_at INTEGER,
			CHECK (
				(state = 'pending' AND ref_scope IS NULL AND confirmed_at IS NULL)
				OR (state = 'confirmed' AND ref_scope IS NOT NULL AND confirmed_at IS NOT NULL)
				OR state = 'expired'
			)
		);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_connection_requests_pending_key
			ON workflow_connection_requests(connection_key) WHERE state = 'pending';
		CREATE INDEX IF NOT EXISTS idx_workflow_connection_requests_expiry
			ON workflow_connection_requests(state, expires_at);
	`);
}

export function workflowConnectionPolicyMatches(
	policy: StoredWorkloadPolicy,
	claim: WorkflowConnectionClaim,
): boolean {
	return (
		policy.active &&
		policy.repository === claim.repository &&
		policy.repositoryId === claim.repositoryId &&
		policy.repositoryOwnerId === claim.repositoryOwnerId &&
		workflowRefRuleMatches(policy.workflowRef, claim.workflowRef) &&
		(policy.allowedRefs.length === 0 ||
			policy.allowedRefs.some((rule) => refRuleMatches(rule, claim.ref))) &&
		(policy.allowedEnvironments.length === 0 ||
			(claim.environment !== null && policy.allowedEnvironments.includes(claim.environment)))
	);
}

export function workflowConnectionPolicy(
	request: StoredWorkflowConnectionRequest,
	refScope: WorkflowConnectionRefScope,
) {
	if (refScope === "version_tags" && !request.claim.ref.startsWith("refs/tags/")) {
		throw new WorkflowConnectionError();
	}
	let workflowRef = request.claim.workflowRef;
	if (refScope === "version_tags") {
		const separator = workflowRef.lastIndexOf("@");
		const workflowSourceRef = workflowRef.slice(separator + 1);
		if (workflowSourceRef.startsWith("refs/tags/")) {
			workflowRef = `${workflowRef.slice(0, separator + 1)}refs/tags/*`;
		}
	}
	return {
		packageSlug: request.packageSlug,
		repository: request.claim.repository,
		repositoryId: request.claim.repositoryId,
		repositoryOwnerId: request.claim.repositoryOwnerId,
		workflowRef,
		allowedRefs: [refScope === "version_tags" ? "refs/tags/*" : request.claim.ref],
		allowedEnvironments: request.claim.environment ? [request.claim.environment] : [],
		active: true,
	} as const;
}

export class WorkflowConnectionStore {
	constructor(private readonly storage: DurableObjectStorage) {}

	#read(requestId: string): WorkflowConnectionRequestRow | null {
		return (
			this.storage.sql
				.exec<WorkflowConnectionRequestRow>(
					`SELECT id, mutation_key, connection_key, package_slug, claim_json, state,
					        ref_scope, expected_policy_version, expires_at, created_at, confirmed_at
					 FROM workflow_connection_requests WHERE id = ?`,
					requestId,
				)
				.toArray()[0] ?? null
		);
	}

	#expire(now: number): void {
		this.storage.sql.exec(
			`UPDATE workflow_connection_requests SET state = 'expired'
			 WHERE state = 'pending' AND expires_at <= ?`,
			now,
		);
		this.storage.sql.exec(
			"DELETE FROM workflow_connection_requests WHERE state IN ('confirmed', 'expired') AND expires_at <= ?",
			now - REQUEST_RETENTION_MS,
		);
	}

	create(
		input: CreateWorkflowConnectionRequestInput,
		expectedPolicyVersion: number | null,
	): CreateWorkflowConnectionRequestResult {
		const now = input.now ?? Date.now();
		const claim = normalizeClaim(input.claim);
		if (
			!DID_PATTERN.test(input.publisherDid) ||
			!ULID_PATTERN.test(input.requestId) ||
			!IDEMPOTENCY_KEY_PATTERN.test(input.mutationKey) ||
			!DIGEST_PATTERN.test(input.connectionKey) ||
			!PACKAGE_SLUG_PATTERN.test(input.packageSlug) ||
			!claim ||
			(expectedPolicyVersion !== null &&
				(!Number.isSafeInteger(expectedPolicyVersion) || expectedPolicyVersion < 1)) ||
			!Number.isSafeInteger(now) ||
			!Number.isSafeInteger(input.expiresAt) ||
			input.expiresAt <= now ||
			input.expiresAt - now > MAX_REQUEST_LIFETIME_MS
		) {
			throw new WorkflowConnectionError();
		}
		const claimJson = JSON.stringify(claim);
		return this.storage.transactionSync(() => {
			this.#expire(now);
			const mutation = this.storage.sql
				.exec<WorkflowConnectionRequestRow>(
					`SELECT id, mutation_key, connection_key, package_slug, claim_json, state,
					        ref_scope, expected_policy_version, expires_at, created_at, confirmed_at
					 FROM workflow_connection_requests WHERE mutation_key = ?`,
					input.mutationKey,
				)
				.toArray()[0];
			if (mutation) {
				if (
					mutation.state !== "pending" ||
					mutation.connection_key !== input.connectionKey ||
					mutation.package_slug !== input.packageSlug ||
					mutation.claim_json !== claimJson
				) {
					return { ok: false, code: "WORKFLOW_CONNECTION_CONFLICT" } as const;
				}
				return { ok: true, request: rowToRequest(mutation), replayed: true } as const;
			}
			const pending = this.storage.sql
				.exec<WorkflowConnectionRequestRow>(
					`SELECT id, mutation_key, connection_key, package_slug, claim_json, state,
					        ref_scope, expected_policy_version, expires_at, created_at, confirmed_at
					 FROM workflow_connection_requests
					 WHERE connection_key = ? AND state = 'pending'`,
					input.connectionKey,
				)
				.toArray()[0];
			if (pending) return { ok: true, request: rowToRequest(pending), replayed: true } as const;
			const active = this.storage.sql
				.exec<{ count: number }>(
					"SELECT COUNT(*) AS count FROM workflow_connection_requests WHERE state = 'pending'",
				)
				.one().count;
			if (active >= MAX_ACTIVE_REQUESTS) {
				return { ok: false, code: "WORKFLOW_CONNECTION_LIMIT_REACHED" } as const;
			}
			this.storage.sql.exec(
				`INSERT INTO workflow_connection_requests (
					id, mutation_key, connection_key, package_slug, claim_json, state, ref_scope,
					expected_policy_version, expires_at, created_at, confirmed_at
				) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, NULL)`,
				input.requestId,
				input.mutationKey,
				input.connectionKey,
				input.packageSlug,
				claimJson,
				expectedPolicyVersion,
				input.expiresAt,
				now,
			);
			return { ok: true, request: rowToRequest(this.#read(input.requestId)!), replayed: false };
		});
	}

	get(requestId: string, now = Date.now()): StoredWorkflowConnectionRequest | null {
		if (!ULID_PATTERN.test(requestId) || !Number.isSafeInteger(now)) {
			throw new WorkflowConnectionError();
		}
		this.#expire(now);
		const row = this.#read(requestId);
		return row ? rowToRequest(row) : null;
	}

	listPending(limit: number, now = Date.now()): readonly StoredWorkflowConnectionRequest[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20 || !Number.isSafeInteger(now)) {
			throw new WorkflowConnectionError();
		}
		this.#expire(now);
		return this.storage.sql
			.exec<WorkflowConnectionRequestRow>(
				`SELECT id, mutation_key, connection_key, package_slug, claim_json, state,
				        ref_scope, expected_policy_version, expires_at, created_at, confirmed_at
				 FROM workflow_connection_requests WHERE state = 'pending'
				 ORDER BY created_at DESC, id DESC LIMIT ?`,
				limit,
			)
			.toArray()
			.map(rowToRequest);
	}

	prepareConfirmation(
		requestId: string,
		now = Date.now(),
	): PrepareWorkflowConnectionConfirmationResult {
		const request = this.get(requestId, now);
		if (!request) return { ok: false, code: "WORKFLOW_CONNECTION_NOT_FOUND" };
		if (request.state === "expired") return { ok: false, code: "WORKFLOW_CONNECTION_EXPIRED" };
		return { ok: true, request, replayed: request.state === "confirmed" };
	}

	complete(
		requestId: string,
		refScope: WorkflowConnectionRefScope,
		now = Date.now(),
	): StoredWorkflowConnectionRequest {
		if (
			!ULID_PATTERN.test(requestId) ||
			(refScope !== "current_ref" && refScope !== "version_tags") ||
			!Number.isSafeInteger(now)
		) {
			throw new WorkflowConnectionError();
		}
		this.storage.sql.exec(
			`UPDATE workflow_connection_requests
			 SET state = 'confirmed', ref_scope = ?, confirmed_at = ?
			 WHERE id = ? AND state = 'pending'`,
			refScope,
			now,
			requestId,
		);
		const row = this.#read(requestId);
		if (!row || row.state !== "confirmed") throw new WorkflowConnectionError();
		return rowToRequest(row);
	}

	expire(now: number): void {
		if (!Number.isSafeInteger(now)) throw new WorkflowConnectionError();
		this.#expire(now);
	}

	nextExpiry(): number | null {
		return this.storage.sql
			.exec<{ expires_at: number | null }>(
				"SELECT MIN(expires_at) AS expires_at FROM workflow_connection_requests WHERE state = 'pending'",
			)
			.one().expires_at;
	}
}
