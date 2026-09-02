const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const PACKAGE_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/;
const REF_PATTERN = /^refs\/[A-Za-z0-9._/-]{1,507}$/;
const WORKFLOW_PATH_PATTERN =
	/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_./-]+\.ya?ml$/;
const MAX_POLICY_VALUES = 32;
const MAX_LIST_LIMIT = 101;

export interface StoredWorkloadPolicy {
	packageSlug: string;
	repository: string;
	repositoryId: string;
	repositoryOwnerId: string;
	workflowRef: string;
	allowedRefs: readonly string[];
	allowedEnvironments: readonly string[];
	active: boolean;
	stateVersion: number;
	authorizedBy: string;
	createdAt: number;
	updatedAt: number;
}

export interface PutWorkloadPolicyInput {
	publisherDid: string;
	packageSlug: string;
	repository: string;
	repositoryId: string;
	repositoryOwnerId: string;
	workflowRef: string;
	allowedRefs: readonly string[];
	allowedEnvironments: readonly string[];
	active: boolean;
	expectedVersion: number | null;
	now?: number;
}

export type PutWorkloadPolicyResult =
	| { ok: true; policy: StoredWorkloadPolicy }
	| { ok: false; code: "WORKLOAD_POLICY_CAS_REQUIRED" };

export interface InvalidatedApprovalChallenges {
	intentId: string;
	approverDids: readonly string[];
}

export type WorkloadPolicyStoreResult =
	| {
			ok: true;
			policy: StoredWorkloadPolicy;
			invalidatedApprovalChallenges: readonly InvalidatedApprovalChallenges[];
	  }
	| { ok: false; code: "WORKLOAD_POLICY_CAS_REQUIRED" };

interface WorkloadPolicyRow {
	[key: string]: string | number | ArrayBuffer | null;
	package_slug: string;
	repository: string;
	repository_id: string;
	repository_owner_id: string;
	workflow_ref: string;
	allowed_refs: string;
	allowed_environments: string;
	active: number;
	state_version: number;
	authorized_by: string;
	created_at: number;
	updated_at: number;
}

interface InvalidatedIntentRow {
	[key: string]: string | number | ArrayBuffer | null;
	id: string;
	state: string;
	state_generation: number;
	state_data_json: string;
	workload_identity_digest: string;
	operation_generation: number | null;
	operation_phase: string | null;
	operation_status: string | null;
}

export class WorkloadPolicyError extends Error {
	readonly code = "WORKLOAD_POLICY_INVALID";

	constructor() {
		super("WORKLOAD_POLICY_INVALID");
		this.name = "WorkloadPolicyError";
	}
}

function normalizeValues(
	values: readonly string[],
	validate: (value: string) => boolean,
): readonly string[] {
	if (!Array.isArray(values) || values.length > MAX_POLICY_VALUES) throw new WorkloadPolicyError();
	const normalized = [...values];
	if (normalized.some((value) => typeof value !== "string" || !validate(value))) {
		throw new WorkloadPolicyError();
	}
	normalized.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
	if (new Set(normalized).size !== normalized.length) throw new WorkloadPolicyError();
	return normalized;
}

function parseStringArray(value: string, validate: (item: string) => boolean): readonly string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new WorkloadPolicyError();
	}
	if (
		!Array.isArray(parsed) ||
		parsed.length > MAX_POLICY_VALUES ||
		parsed.some((item) => typeof item !== "string" || !validate(item))
	) {
		throw new WorkloadPolicyError();
	}
	return parsed;
}

function validEnvironment(value: string): boolean {
	if (value.length === 0 || value.length > 255) return false;
	for (const character of value) {
		const codePoint = character.codePointAt(0)!;
		if (codePoint <= 31 || codePoint === 127) return false;
	}
	return true;
}

function approvalChallengeInvalidation(
	row: InvalidatedIntentRow,
): InvalidatedApprovalChallenges | null {
	if (row.state !== "awaiting_approval") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(row.state_data_json);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const approverDids = Reflect.get(parsed, "approverDids");
	if (
		!Array.isArray(approverDids) ||
		approverDids.length > MAX_POLICY_VALUES ||
		new Set(approverDids).size !== approverDids.length ||
		approverDids.some((value) => typeof value !== "string" || !DID_PATTERN.test(value))
	) {
		return null;
	}
	return { intentId: row.id, approverDids };
}

export function validRefRule(value: string): boolean {
	if (REF_PATTERN.test(value)) return true;
	if (!value.endsWith("*")) return false;
	const prefix = value.slice(0, -1);
	return (
		(prefix.startsWith("refs/heads/") || prefix.startsWith("refs/tags/")) &&
		REF_PATTERN.test(prefix)
	);
}

export function refRuleMatches(rule: string, value: string): boolean {
	if (!validRefRule(rule) || !REF_PATTERN.test(value)) return false;
	return rule.endsWith("*") ? value.startsWith(rule.slice(0, -1)) : rule === value;
}

export function validWorkflowRefRule(value: string): boolean {
	const separator = value.lastIndexOf("@");
	if (separator < 1) return false;
	return (
		WORKFLOW_PATH_PATTERN.test(value.slice(0, separator)) &&
		validRefRule(value.slice(separator + 1))
	);
}

export function workflowRefRuleMatches(rule: string, value: string): boolean {
	const normalizedRule = normalizeWorkflowRefRepository(rule);
	const normalizedValue = normalizeWorkflowRefRepository(value);
	const ruleSeparator = normalizedRule.lastIndexOf("@");
	const valueSeparator = normalizedValue.lastIndexOf("@");
	if (ruleSeparator < 1 || valueSeparator < 1) return false;
	return (
		normalizedRule.slice(0, ruleSeparator) === normalizedValue.slice(0, valueSeparator) &&
		refRuleMatches(
			normalizedRule.slice(ruleSeparator + 1),
			normalizedValue.slice(valueSeparator + 1),
		)
	);
}

export function normalizeWorkflowRefRepository(value: string): string {
	const marker = "/.github/workflows/";
	const markerIndex = value.indexOf(marker);
	if (markerIndex < 1) return value;
	return `${value.slice(0, markerIndex).toLowerCase()}${value.slice(markerIndex)}`;
}

function rowToPolicy(row: WorkloadPolicyRow): StoredWorkloadPolicy {
	return {
		packageSlug: row.package_slug,
		repository: row.repository,
		repositoryId: row.repository_id,
		repositoryOwnerId: row.repository_owner_id,
		workflowRef: row.workflow_ref,
		allowedRefs: parseStringArray(row.allowed_refs, validRefRule),
		allowedEnvironments: parseStringArray(row.allowed_environments, validEnvironment),
		active: row.active === 1,
		stateVersion: row.state_version,
		authorizedBy: row.authorized_by,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function initializeWorkloadPolicySchema(storage: DurableObjectStorage): void {
	storage.sql.exec(`
		CREATE TABLE IF NOT EXISTS workload_policies (
			package_slug TEXT PRIMARY KEY,
			repository TEXT NOT NULL,
			repository_id TEXT NOT NULL,
			repository_owner_id TEXT NOT NULL,
			workflow_ref TEXT NOT NULL,
			allowed_refs TEXT NOT NULL,
			allowed_environments TEXT NOT NULL,
			active INTEGER NOT NULL CHECK (active IN (0, 1)),
			state_version INTEGER NOT NULL CHECK (state_version >= 1),
			authorized_by TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_workload_policies_active
			ON workload_policies(active, package_slug);
	`);
}

export class WorkloadPolicyStore {
	readonly #storage: DurableObjectStorage;

	constructor(storage: DurableObjectStorage) {
		this.#storage = storage;
	}

	put(input: PutWorkloadPolicyInput): WorkloadPolicyStoreResult {
		const now = input.now ?? Date.now();
		if (typeof input.repository !== "string" || typeof input.workflowRef !== "string") {
			throw new WorkloadPolicyError();
		}
		const repository = input.repository.toLowerCase();
		const workflowRef = normalizeWorkflowRefRepository(input.workflowRef);
		const allowedRefs = normalizeValues(input.allowedRefs, validRefRule);
		const allowedEnvironments = normalizeValues(input.allowedEnvironments, validEnvironment);
		if (
			!DID_PATTERN.test(input.publisherDid) ||
			!PACKAGE_SLUG_PATTERN.test(input.packageSlug) ||
			!REPOSITORY_PATTERN.test(repository) ||
			!DECIMAL_ID_PATTERN.test(input.repositoryId) ||
			!DECIMAL_ID_PATTERN.test(input.repositoryOwnerId) ||
			!validWorkflowRefRule(input.workflowRef) ||
			!workflowRef.startsWith(`${repository}/.github/workflows/`) ||
			typeof input.active !== "boolean" ||
			(input.expectedVersion !== null &&
				(!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)) ||
			!Number.isSafeInteger(now) ||
			now < 0
		) {
			throw new WorkloadPolicyError();
		}
		return this.#storage.transactionSync(() => {
			const current = this.get(input.packageSlug);
			if (
				(current === null && input.expectedVersion !== null) ||
				(current !== null && current.stateVersion !== input.expectedVersion)
			) {
				return { ok: false, code: "WORKLOAD_POLICY_CAS_REQUIRED" } as const;
			}
			const stateVersion = (current?.stateVersion ?? 0) + 1;
			const createdAt = current?.createdAt ?? now;
			this.#storage.sql.exec(
				`INSERT INTO workload_policies (
					package_slug, repository, repository_id, repository_owner_id,
					workflow_ref, allowed_refs, allowed_environments, active,
					state_version, authorized_by, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(package_slug) DO UPDATE SET
					repository = excluded.repository,
					repository_id = excluded.repository_id,
					repository_owner_id = excluded.repository_owner_id,
					workflow_ref = excluded.workflow_ref,
					allowed_refs = excluded.allowed_refs,
					allowed_environments = excluded.allowed_environments,
					active = excluded.active,
					state_version = excluded.state_version,
					authorized_by = excluded.authorized_by,
					updated_at = excluded.updated_at`,
				input.packageSlug,
				repository,
				input.repositoryId,
				input.repositoryOwnerId,
				workflowRef,
				JSON.stringify(allowedRefs),
				JSON.stringify(allowedEnvironments),
				input.active ? 1 : 0,
				stateVersion,
				input.publisherDid,
				createdAt,
				now,
			);
			this.#storage.sql.exec(
				`INSERT INTO audit_events (
					event_type, actor_realm, actor_identity, subject,
					reason_code, public_payload, created_at
				) VALUES ('workload-policy-stored', 'publisher', ?, ?, NULL, '{}', ?)`,
				input.publisherDid,
				input.packageSlug,
				now,
			);
			const invalidatedApprovalChallenges = this.#invalidatePreWriteIntents(
				input.publisherDid,
				input.packageSlug,
				stateVersion,
				now,
			);
			return {
				ok: true,
				policy: this.get(input.packageSlug)!,
				invalidatedApprovalChallenges,
			} as const;
		});
	}

	#invalidatePreWriteIntents(
		publisherDid: string,
		packageSlug: string,
		policyVersion: number,
		now: number,
	): readonly InvalidatedApprovalChallenges[] {
		const rows = this.#storage.sql
			.exec<InvalidatedIntentRow>(
				`SELECT intents.id, intents.state, intents.state_generation,
				        intents.state_data_json, intents.workload_identity_digest,
				        publication_operations.generation AS operation_generation,
				        publication_operations.phase AS operation_phase,
				        publication_operations.status AS operation_status
				 FROM intents
				 LEFT JOIN publication_operations ON publication_operations.intent_id = intents.id
				 WHERE intents.package_slug = ?
				   AND intents.workload_policy_version <> ?
				   AND intents.state IN (
				     'received', 'verifying', 'verified', 'awaiting_approval', 'ready', 'publishing'
				   )`,
				packageSlug,
				policyVersion,
			)
			.toArray();
		const invalidatedApprovalChallenges: InvalidatedApprovalChallenges[] = [];
		for (const row of rows) {
			if (
				row.state === "publishing" &&
				row.operation_status === "active" &&
				row.operation_phase === "creating"
			) {
				continue;
			}
			const approvalInvalidation = approvalChallengeInvalidation(row);
			if (approvalInvalidation) invalidatedApprovalChallenges.push(approvalInvalidation);
			const nextGeneration = row.state_generation + 1;
			const stateDataJson = '{"reasonCode":"WORKLOAD_POLICY_CHANGED"}';
			this.#storage.sql.exec(
				`UPDATE intents SET state = 'invalid', state_generation = ?,
				        state_data_json = ?, updated_at = ? WHERE id = ?`,
				nextGeneration,
				stateDataJson,
				now,
				row.id,
			);
			this.#storage.sql.exec(
				`INSERT INTO intent_transitions (
					intent_id, sequence, from_state, to_state, state_generation,
					transition_digest, actor_realm, actor_identity, reason_code,
					state_data_json, created_at
				) VALUES (?, ?, ?, 'invalid', ?, ?, 'publisher', ?,
				          'WORKLOAD_POLICY_CHANGED', ?, ?)`,
				row.id,
				nextGeneration,
				row.state,
				nextGeneration,
				row.workload_identity_digest,
				publisherDid,
				stateDataJson,
				now,
			);
			this.#storage.sql.exec("DELETE FROM release_reservations WHERE intent_id = ?", row.id);
			if (
				row.state === "publishing" &&
				row.operation_status === "active" &&
				row.operation_generation !== null
			) {
				this.#storage.sql.exec(
					`UPDATE publication_operations SET status = 'completed',
					        completion_digest = token_hash, outcome = 'failed',
					        reason_code = 'WORKLOAD_POLICY_CHANGED', completed_at = ?
					 WHERE intent_id = ? AND generation = ? AND status = 'active'`,
					now,
					row.id,
					row.operation_generation,
				);
				this.#storage.sql.exec(
					"DELETE FROM deadlines WHERE kind = 'publication-operation' AND subject_id = ?",
					row.id,
				);
			}
			this.#storage.sql.exec(
				`INSERT INTO audit_events (
					event_type, actor_realm, actor_identity, subject,
					reason_code, public_payload, created_at
				) VALUES ('intent-invalidated', 'publisher', ?, ?,
				          'WORKLOAD_POLICY_CHANGED', '{}', ?)`,
				publisherDid,
				row.id,
				now,
			);
		}
		return invalidatedApprovalChallenges;
	}

	get(packageSlug: string): StoredWorkloadPolicy | null {
		if (!PACKAGE_SLUG_PATTERN.test(packageSlug)) throw new WorkloadPolicyError();
		const row = this.#storage.sql
			.exec<WorkloadPolicyRow>(
				`SELECT package_slug, repository, repository_id, repository_owner_id,
				        workflow_ref, allowed_refs, allowed_environments, active,
				        state_version, authorized_by, created_at, updated_at
				 FROM workload_policies WHERE package_slug = ?`,
				packageSlug,
			)
			.toArray()[0];
		return row ? rowToPolicy(row) : null;
	}

	list(afterPackageSlug: string | null, limit: number): readonly StoredWorkloadPolicy[] {
		if (
			(afterPackageSlug !== null && !PACKAGE_SLUG_PATTERN.test(afterPackageSlug)) ||
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > MAX_LIST_LIMIT
		) {
			throw new WorkloadPolicyError();
		}
		return this.#storage.sql
			.exec<WorkloadPolicyRow>(
				`SELECT package_slug, repository, repository_id, repository_owner_id,
				        workflow_ref, allowed_refs, allowed_environments, active,
				        state_version, authorized_by, created_at, updated_at
				 FROM workload_policies
				 WHERE (? IS NULL OR package_slug > ?)
				 ORDER BY package_slug LIMIT ?`,
				afterPackageSlug,
				afterPackageSlug,
				limit,
			)
			.toArray()
			.map(rowToPolicy);
	}
}
