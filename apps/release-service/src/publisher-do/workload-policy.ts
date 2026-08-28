const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const PACKAGE_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/;
const REF_PATTERN = /^refs\/[A-Za-z0-9._/-]{1,507}$/;
const WORKFLOW_REF_PATTERN =
	/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_./-]+\.ya?ml@refs\/[A-Za-z0-9._/-]+$/;
const MAX_POLICY_VALUES = 32;

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
	normalized.sort((left, right) => left.localeCompare(right));
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
		allowedRefs: parseStringArray(row.allowed_refs, (value) => REF_PATTERN.test(value)),
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

	put(input: PutWorkloadPolicyInput): PutWorkloadPolicyResult {
		const now = input.now ?? Date.now();
		if (typeof input.repository !== "string" || typeof input.workflowRef !== "string") {
			throw new WorkloadPolicyError();
		}
		const repository = input.repository.toLowerCase();
		const workflowRef = normalizeWorkflowRefRepository(input.workflowRef);
		const allowedRefs = normalizeValues(input.allowedRefs, (value) => REF_PATTERN.test(value));
		const allowedEnvironments = normalizeValues(input.allowedEnvironments, validEnvironment);
		if (
			!DID_PATTERN.test(input.publisherDid) ||
			!PACKAGE_SLUG_PATTERN.test(input.packageSlug) ||
			!REPOSITORY_PATTERN.test(repository) ||
			!DECIMAL_ID_PATTERN.test(input.repositoryId) ||
			!DECIMAL_ID_PATTERN.test(input.repositoryOwnerId) ||
			!WORKFLOW_REF_PATTERN.test(input.workflowRef) ||
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
			return { ok: true, policy: this.get(input.packageSlug)! } as const;
		});
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
			limit > 100
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
