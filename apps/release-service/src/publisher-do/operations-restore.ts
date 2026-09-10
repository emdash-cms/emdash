const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const PACKAGE_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.-]{0,127}$/;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ARCHIVE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;
const ACTOR_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const MAX_JSON_CHARS = 1024 * 1024;

export type PublisherRestoreKind = "audit-events" | "intents" | "metadata" | "workload-policies";

export interface ApplyPublisherRestorePageInput {
	publisherDid: string;
	archiveId: string;
	page: number;
	totalPages: number;
	kind: PublisherRestoreKind;
	dataJson: string;
	pageDigest: string;
	actorIdentity: string;
	now?: number;
}

export type ApplyPublisherRestorePageResult =
	| { ok: true; replayed: boolean; complete: boolean; nextPage: number }
	| { ok: false; code: "RESTORE_CONFLICT" | "RESTORE_NOT_EMPTY" | "RESTORE_OUT_OF_ORDER" };

export class OperationsRestoreError extends Error {
	constructor() {
		super("OPERATIONS_RESTORE_INVALID");
		this.name = "OperationsRestoreError";
	}
}

interface RestoreStateRow {
	[key: string]: string | number | ArrayBuffer | null;
	archive_id: string;
	total_pages: number;
	next_page: number;
	last_kind: PublisherRestoreKind;
	status: "aborted" | "complete" | "prepared" | "restoring";
	deleted_intents: number;
	deleted_workloads: number;
}

interface RestorePageRow {
	[key: string]: string | number | ArrayBuffer | null;
	page_digest: string;
}

const KIND_ORDER: Readonly<Record<PublisherRestoreKind, number>> = {
	metadata: 0,
	"workload-policies": 1,
	intents: 2,
	"audit-events": 3,
};

const TERMINAL_STATES = new Set([
	"published",
	"invalid",
	"rejected",
	"cancelled",
	"expired",
	"failed",
	"conflict",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string {
	const item = value[key];
	if (typeof item !== "string") throw new OperationsRestoreError();
	return item;
}

function nullableStringField(value: Record<string, unknown>, key: string): string | null {
	const item = value[key];
	if (item !== null && typeof item !== "string") throw new OperationsRestoreError();
	return item;
}

function integerField(value: Record<string, unknown>, key: string): number {
	const item = value[key];
	if (!Number.isSafeInteger(item)) throw new OperationsRestoreError();
	return Number(item);
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new OperationsRestoreError();
	}
	return value;
}

function parseData(value: string): Record<string, unknown> {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_JSON_CHARS) {
		throw new OperationsRestoreError();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new OperationsRestoreError();
	}
	if (!isRecord(parsed) || JSON.stringify(parsed) !== value) throw new OperationsRestoreError();
	return parsed;
}

export function initializeOperationsRestoreSchema(storage: DurableObjectStorage): void {
	storage.sql.exec(`
		CREATE TABLE IF NOT EXISTS operations_restore (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			archive_id TEXT NOT NULL,
			total_pages INTEGER NOT NULL CHECK (total_pages >= 1),
			next_page INTEGER NOT NULL CHECK (next_page >= 0),
			last_kind TEXT NOT NULL CHECK (
				last_kind IN ('metadata', 'workload-policies', 'intents', 'audit-events')
			),
			status TEXT NOT NULL CHECK (status IN ('prepared', 'restoring', 'complete', 'aborted')),
			deleted_intents INTEGER NOT NULL CHECK (deleted_intents >= 0),
			deleted_workloads INTEGER NOT NULL CHECK (deleted_workloads >= 0),
			actor_identity TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS operations_restore_pages (
			archive_id TEXT NOT NULL,
			page INTEGER NOT NULL CHECK (page >= 0),
			page_digest TEXT NOT NULL,
			kind TEXT NOT NULL CHECK (
				kind IN ('metadata', 'workload-policies', 'intents', 'audit-events')
			),
			applied_at INTEGER NOT NULL,
			PRIMARY KEY (archive_id, page)
		);
	`);
}

export class OperationsRestoreStore {
	constructor(private readonly storage: DurableObjectStorage) {}

	apply(input: ApplyPublisherRestorePageInput): ApplyPublisherRestorePageResult {
		const now = input.now ?? Date.now();
		if (
			!DID_PATTERN.test(input.publisherDid) ||
			!ARCHIVE_ID_PATTERN.test(input.archiveId) ||
			!Number.isSafeInteger(input.page) ||
			input.page < 0 ||
			!Number.isSafeInteger(input.totalPages) ||
			input.totalPages < 1 ||
			input.page >= input.totalPages ||
			!Object.hasOwn(KIND_ORDER, input.kind) ||
			!DIGEST_PATTERN.test(input.pageDigest) ||
			!ACTOR_IDENTITY_PATTERN.test(input.actorIdentity) ||
			!Number.isSafeInteger(now) ||
			now < 0
		) {
			throw new OperationsRestoreError();
		}
		const data = parseData(input.dataJson);
		return this.storage.transactionSync(() => {
			const applied = this.storage.sql
				.exec<RestorePageRow>(
					"SELECT page_digest FROM operations_restore_pages WHERE archive_id = ? AND page = ?",
					input.archiveId,
					input.page,
				)
				.toArray()[0];
			if (applied) {
				if (applied.page_digest !== input.pageDigest) {
					return { ok: false, code: "RESTORE_CONFLICT" } as const;
				}
				const state = this.#state();
				return {
					ok: true,
					replayed: true,
					complete: state?.status === "complete",
					nextPage: state?.next_page ?? input.page + 1,
				} as const;
			}
			const state = this.#state();
			if (input.page === 0) {
				if (
					input.kind !== "metadata" ||
					!state ||
					state.archive_id !== input.archiveId ||
					state.total_pages !== input.totalPages ||
					state.next_page !== 0 ||
					state.status !== "prepared"
				) {
					return { ok: false, code: "RESTORE_OUT_OF_ORDER" } as const;
				}
				if (!this.#emptyShard()) {
					return { ok: false, code: "RESTORE_NOT_EMPTY" } as const;
				}
			} else if (
				!state ||
				state.archive_id !== input.archiveId ||
				state.total_pages !== input.totalPages ||
				state.next_page !== input.page ||
				state.status !== "restoring" ||
				KIND_ORDER[input.kind] < KIND_ORDER[state.last_kind]
			) {
				return { ok: false, code: "RESTORE_OUT_OF_ORDER" } as const;
			}

			this.#applyData(input.publisherDid, input.kind, data, input.actorIdentity, now);
			const nextPage = input.page + 1;
			const complete = nextPage === input.totalPages;
			this.storage.sql.exec(
				`UPDATE operations_restore SET
					next_page = ?, last_kind = ?, status = ?, actor_identity = ?, updated_at = ?
				 WHERE id = 1 AND archive_id = ? AND total_pages = ?`,
				nextPage,
				input.kind,
				complete ? "complete" : "restoring",
				input.actorIdentity,
				now,
				input.archiveId,
				input.totalPages,
			);
			this.storage.sql.exec(
				`INSERT INTO operations_restore_pages (
					archive_id, page, page_digest, kind, applied_at
				) VALUES (?, ?, ?, ?, ?)`,
				input.archiveId,
				input.page,
				input.pageDigest,
				input.kind,
				now,
			);
			if (complete) {
				this.#audit(
					"publisher-restore-completed",
					input.actorIdentity,
					input.archiveId,
					now,
					"REAUTHORIZATION_REQUIRED",
				);
			}
			return { ok: true, replayed: false, complete, nextPage } as const;
		});
	}

	#state(): RestoreStateRow | null {
		return (
			this.storage.sql
				.exec<RestoreStateRow>(
					`SELECT archive_id, total_pages, next_page, last_kind, status,
					        deleted_intents, deleted_workloads
					 FROM operations_restore WHERE id = 1`,
				)
				.toArray()[0] ?? null
		);
	}

	#emptyShard(): boolean {
		const counts = this.storage.sql
			.exec<{ count: number }>(
				`SELECT (
					(SELECT COUNT(*) FROM workload_policies) +
					(SELECT COUNT(*) FROM intents) +
					(SELECT COUNT(*) FROM delegation)
				) AS count`,
			)
			.one();
		return counts.count === 0;
	}

	#applyData(
		publisherDid: string,
		kind: PublisherRestoreKind,
		data: Record<string, unknown>,
		actorIdentity: string,
		now: number,
	): void {
		if (kind === "metadata") {
			this.#restoreMetadata(publisherDid, data, actorIdentity, now);
			return;
		}
		const items = data["items"];
		if (!Array.isArray(items)) throw new OperationsRestoreError();
		if (kind === "workload-policies") {
			for (const item of items) this.#restoreWorkload(publisherDid, item, now);
			return;
		}
		if (kind === "intents") {
			for (const item of items) this.#restoreIntent(item, now);
			return;
		}
		for (const item of items) {
			if (!isRecord(item) || !Number.isSafeInteger(item["sequence"])) {
				throw new OperationsRestoreError();
			}
		}
	}

	#restoreMetadata(
		publisherDid: string,
		data: Record<string, unknown>,
		actorIdentity: string,
		now: number,
	): void {
		const publisher = data["publisher"];
		if (!isRecord(publisher) || stringField(publisher, "did") !== publisherDid) {
			throw new OperationsRestoreError();
		}
		const createdAt = integerField(publisher, "createdAt");
		this.storage.sql.exec(
			`UPDATE publisher SET status = 'suspended', session_epoch = session_epoch + 1,
			 created_at = ? WHERE id = 1 AND did = ?`,
			createdAt,
			publisherDid,
		);
		this.storage.sql.exec("DELETE FROM publisher_sessions");
		this.storage.sql.exec("DELETE FROM oauth_states");
		this.storage.sql.exec("DELETE FROM delegation");
		const delegation = data["delegation"];
		if (delegation !== null) {
			if (!isRecord(delegation)) throw new OperationsRestoreError();
			const originalStatus = stringField(delegation, "status");
			if (
				originalStatus !== "active" &&
				originalStatus !== "revoked" &&
				originalStatus !== "reauthorization_required"
			) {
				throw new OperationsRestoreError();
			}
			this.storage.sql.exec(
				`INSERT INTO delegation (
					id, release_nsid, scope, client_key_id, encrypted_session,
					encryption_key_version, issuer, pds_url, expires_at, refresh_before,
					status, state_version, updated_at
				) VALUES (1, ?, ?, 'restore-required', '', NULL, ?, ?, ?, ?, ?, ?, ?)`,
				stringField(delegation, "releaseNsid"),
				stringField(delegation, "scope"),
				nullableStringField(delegation, "issuer"),
				nullableStringField(delegation, "pdsUrl"),
				delegation["expiresAt"] === null ? null : integerField(delegation, "expiresAt"),
				delegation["refreshBefore"] === null ? null : integerField(delegation, "refreshBefore"),
				originalStatus === "revoked" ? "revoked" : "reauthorization_required",
				integerField(delegation, "stateVersion") + 1,
				now,
			);
		}
		this.storage.sql.exec(
			`UPDATE delegation_operations SET generation = generation + 1,
			 token_hash = NULL, delegation_version = NULL, expires_at = NULL, updated_at = ?
			 WHERE kind = 'refresh'`,
			now,
		);
		this.#audit(
			"publisher-restore-started",
			actorIdentity,
			publisherDid,
			now,
			"PUBLISHER_SUSPENDED",
		);
	}

	#restoreWorkload(publisherDid: string, value: unknown, now: number): void {
		if (!isRecord(value)) throw new OperationsRestoreError();
		const packageSlug = stringField(value, "packageSlug");
		const repository = stringField(value, "repository");
		const repositoryId = stringField(value, "repositoryId");
		const repositoryOwnerId = stringField(value, "repositoryOwnerId");
		const workflowRef = stringField(value, "workflowRef");
		if (
			!PACKAGE_SLUG_PATTERN.test(packageSlug) ||
			repository.length === 0 ||
			repository.length > 256 ||
			repositoryId.length === 0 ||
			repositoryOwnerId.length === 0 ||
			workflowRef.length === 0 ||
			workflowRef.length > 1024
		) {
			throw new OperationsRestoreError();
		}
		this.storage.sql.exec(
			`INSERT INTO workload_policies (
				package_slug, repository, repository_id, repository_owner_id,
				workflow_ref, allowed_refs, allowed_environments, active,
				state_version, authorized_by, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
			packageSlug,
			repository,
			repositoryId,
			repositoryOwnerId,
			workflowRef,
			JSON.stringify(stringArray(value["allowedRefs"])),
			JSON.stringify(stringArray(value["allowedEnvironments"])),
			Math.max(1, integerField(value, "stateVersion")),
			publisherDid,
			integerField(value, "createdAt"),
			now,
		);
	}

	#restoreIntent(value: unknown, now: number): void {
		if (!isRecord(value)) throw new OperationsRestoreError();
		const intent = value;
		const id = stringField(intent, "id");
		const packageSlug = stringField(intent, "packageSlug");
		const version = stringField(intent, "version");
		const state = stringField(intent, "state");
		const stateGeneration = integerField(intent, "stateGeneration");
		const requestDigest = stringField(intent, "requestDigest");
		const workloadIdentityDigest = stringField(intent, "workloadIdentityDigest");
		const workloadIdempotencyDigest = stringField(intent, "workloadIdempotencyDigest");
		const workloadIdentityJson = stringField(intent, "workloadIdentityJson");
		const releaseInputJson = stringField(intent, "releaseInputJson");
		if (
			!ULID_PATTERN.test(id) ||
			!PACKAGE_SLUG_PATTERN.test(packageSlug) ||
			!VERSION_PATTERN.test(version) ||
			!DIGEST_PATTERN.test(requestDigest) ||
			!DIGEST_PATTERN.test(workloadIdentityDigest) ||
			!DIGEST_PATTERN.test(workloadIdempotencyDigest) ||
			workloadIdentityJson.length > 64 * 1024 ||
			releaseInputJson.length > 128 * 1024 ||
			stateGeneration < 1
		) {
			throw new OperationsRestoreError();
		}
		const restoredState = TERMINAL_STATES.has(state) ? state : "failed";
		const restoredGeneration = TERMINAL_STATES.has(state) ? stateGeneration : stateGeneration + 1;
		const stateDataJson = TERMINAL_STATES.has(state)
			? stringField(intent, "stateDataJson")
			: '{"reasonCode":"SHARD_RESTORED_REVIEW_REQUIRED"}';
		this.storage.sql.exec(
			`INSERT INTO intents (
				id, package_slug, version, state, state_generation,
				workload_policy_version, workload_identity_digest, workload_idempotency_digest,
				request_digest, workload_identity_json, release_input_json, state_data_json,
				workflow_id, expires_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
			id,
			packageSlug,
			version,
			restoredState,
			restoredGeneration,
			Math.max(1, integerField(intent, "workloadPolicyVersion")),
			workloadIdentityDigest,
			workloadIdempotencyDigest,
			requestDigest,
			workloadIdentityJson,
			releaseInputJson,
			stateDataJson,
			integerField(intent, "expiresAt"),
			integerField(intent, "createdAt"),
			now,
		);
		this.storage.sql.exec(
			`INSERT INTO release_reservations (package_slug, version, intent_id, created_at)
			 VALUES (?, ?, ?, ?)`,
			packageSlug,
			version,
			id,
			integerField(intent, "createdAt"),
		);
		this.storage.sql.exec(
			`INSERT INTO intent_transitions (
				intent_id, sequence, from_state, to_state, state_generation,
				transition_digest, actor_realm, actor_identity, reason_code,
				state_data_json, created_at
			) VALUES (?, 1, NULL, ?, ?, ?, 'system', 'release-service', ?, ?, ?)`,
			id,
			restoredState,
			restoredGeneration,
			requestDigest,
			TERMINAL_STATES.has(state) ? "SHARD_RESTORED" : "SHARD_RESTORED_REVIEW_REQUIRED",
			stateDataJson,
			now,
		);
		this.#audit(
			"intent-restored",
			"release-service",
			id,
			now,
			TERMINAL_STATES.has(state) ? "SHARD_RESTORED" : "SHARD_RESTORED_REVIEW_REQUIRED",
		);
	}

	#audit(
		eventType: string,
		actorIdentity: string,
		subject: string,
		createdAt: number,
		reasonCode: string,
	): void {
		this.storage.sql.exec(
			`INSERT INTO audit_events (
				event_type, actor_realm, actor_identity, subject,
				reason_code, public_payload, created_at
			) VALUES (?, ?, ?, ?, ?, '{}', ?)`,
			eventType,
			actorIdentity === "release-service" ? "system" : "access",
			actorIdentity,
			subject,
			reasonCode,
			createdAt,
		);
	}
}
